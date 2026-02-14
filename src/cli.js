#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { bootstrap } from './server.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from './core.js';
import { createMcpProxy } from './mcp-proxy.js';
import { parseSkillFile, parseSkillsDir } from './parsers.js';
import { resolveSkill, searchRegistry } from './registry.js';

const program = new Command();
program.name('vectormcp').description('Semantic MCP tool router').version('0.1.0');

program
  .command('init')
  .description('Create default config.json')
  .action(() => {
    const config = loadConfig();
    saveConfig(config);
    console.log('Initialized config.json');
  });

program
  .command('start')
  .description('Start VectorMCP server')
  .option('-c, --config <path>', 'config path', 'config.json')
  .option('-w, --watch', 'watch skills/source directories and rebuild index on changes')
  .action(async ({ config: configPath, watch }) => {
    if (!fs.existsSync(configPath)) {
      console.error(`Config not found: ${configPath}. Run \`vectormcp init\` first.`);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig(configPath);
    const runtime = await bootstrap(config);

    if (watch) {
      const watchTargets = gatherWatchTargetsFromConfig(config);
      setupWatchers(watchTargets, runtime.rebuildIndex);
    }
  });

program
  .command('scan <directory>')
  .description('Scan a directory for skills/tool files and start immediately')
  .option('-p, --port <n>', 'server port', '3000')
  .option('-w, --watch', 'watch scanned directory and rebuild index on changes')
  .action(async (directory, opts) => {
    const scanDir = path.resolve(directory);
    if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) {
      console.error(`Directory not found: ${scanDir}`);
      process.exitCode = 1;
      return;
    }

    const scanResults = scanDirectory(scanDir);
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectormcp-'));
    const config = {
      ...DEFAULT_CONFIG,
      dataDir: tempDataDir,
      skillsDir: scanDir,
      port: Number(opts.port || 3000),
      sources: scanResults.toolFiles.map((file) => ({
        type: 'file',
        path: file,
        category: 'general'
      }))
    };

    const runtime = await bootstrap(config);
    console.log(`Found ${scanResults.skillCount} skills, ${scanResults.toolFiles.length} tool files. Server running on http://localhost:${config.port}`);

    if (opts.watch) {
      setupWatchers([scanDir], runtime.rebuildIndex);
    }
  });

program
  .command('add-repo <url>')
  .option('--category <name>', 'category tag', 'general')
  .action((url, options) => addSource({ type: 'repo', url, category: options.category }));

program
  .command('add-file <path>')
  .option('--category <name>', 'category tag', 'general')
  .action((filePath, options) => addSource({ type: 'file', path: filePath, category: options.category }));

program
  .command('add-web <url>')
  .option('--category <name>', 'category tag', 'general')
  .action((url, options) => addSource({ type: 'webmcp', url, category: options.category }));


program
  .command('add-skill <path-or-git-url>')
  .description('Add a Claude Skill folder to skillsDir')
  .action((pathOrGitUrl) => addSkill(pathOrGitUrl));

program
  .command('search <query>')
  .description('Search for community skills in the public registry')
  .action(async (query) => {
    const config = loadConfig();
    try {
      const results = await searchRegistry(query, config.registryUrl || DEFAULT_CONFIG.registryUrl);
      if (results.length === 0) {
        console.log('No skills found.');
        return;
      }

      printTable(
        ['NAME', 'DESCRIPTION', 'TAGS'],
        results.map((entry) => [
          entry.name || '',
          entry.description || '',
          Array.isArray(entry.tags) ? entry.tags.join(', ') : ''
        ])
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });

program
  .command('install <name>')
  .description('Install a skill from the public registry (@user/skill-name) or git URL')
  .action(async (name) => {
    const config = loadConfig();
    let skillSource = name;
    const isRegistryName = String(name || '').startsWith('@');

    if (isRegistryName) {
      try {
        skillSource = await resolveSkill(name, config.registryUrl || DEFAULT_CONFIG.registryUrl);
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
    }

    const installResult = installSkillFromSource(skillSource, config.skillsDir || './skills');
    if (!installResult.ok) {
      console.error(installResult.message);
      process.exitCode = 1;
      return;
    }

    const printedName = isRegistryName ? name : installResult.folderName;
    console.log(`Installed ${printedName} to ${path.join(config.skillsDir || './skills', installResult.folderName)}`);
  });

program
  .command('uninstall <name>')
  .description('Remove an installed skill from skillsDir')
  .action((name) => {
    const config = loadConfig();
    const skillsDir = config.skillsDir || './skills';
    const skillName = String(name || '').replace(/^@[^/]+\//, '');
    const destDir = path.join(skillsDir, skillName);

    if (!fs.existsSync(destDir)) {
      console.error(`Skill not found: ${destDir}`);
      process.exitCode = 1;
      return;
    }

    fs.rmSync(destDir, { recursive: true, force: true });
    console.log(`Removed ${skillName} from ${addTrailingSlash(skillsDir)}`);
  });

program
  .command('publish')
  .description('Validate local SKILL.md and print registry publishing steps')
  .action(() => {
    const skillFile = path.join(process.cwd(), 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      console.error('SKILL.md not found in current directory.');
      process.exitCode = 1;
      return;
    }

    const parsed = parseSkillFile(skillFile, process.cwd());
    if (!parsed) {
      console.error('SKILL.md is missing required frontmatter (name, description).');
      process.exitCode = 1;
      return;
    }

    console.log('To publish your skill:');
    console.log('Fork https://github.com/NicoIzco/vectormcp-registry');
    console.log('Add your skill to registry.json');
    console.log('Submit a pull request');
  });

program
  .command('list')
  .description('List all locally installed skills')
  .action(() => {
    const config = loadConfig();
    const skillsDir = config.skillsDir || './skills';

    if (!fs.existsSync(skillsDir)) {
      console.log(`INSTALLED SKILLS (${skillsDir})`);
      console.log('No installed skills.');
      return;
    }

    const skills = parseSkillsDir(skillsDir).map((skill) => ({
      name: skill.name,
      version: skill.version || '-',
      description: skill.description
    }));

    console.log(`INSTALLED SKILLS (${skillsDir})`);
    if (skills.length === 0) {
      console.log('No installed skills.');
      return;
    }

    printTable(
      ['NAME', 'VERSION', 'DESCRIPTION'],
      skills.map((skill) => [skill.name, skill.version, skill.description])
    );
  });

program
  .command('proxy')
  .description('Start MCP proxy mode for Claude Desktop, Cursor, and other MCP clients')
  .option('--transport <type>', 'transport type (stdio|sse)', 'stdio')
  .option('-p, --port <n>', 'port for SSE transport', '3000')
  .option('-c, --config <path>', 'config path', 'config.json')
  .action(async (opts) => {
    if (!fs.existsSync(opts.config)) {
      console.error(`Config not found: ${opts.config}. Run \`vectormcp init\` first.`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig(opts.config);
    const proxy = await createMcpProxy(config);
    const transport = String(opts.transport || 'stdio').toLowerCase();

    if (transport === 'stdio') {
      proxy.transport.startStdio();
      return;
    }

    if (transport === 'sse') {
      proxy.transport.startSse(Number(opts.port || 3000));
      return;
    }

    console.error(`Unsupported transport: ${transport}. Use "stdio" or "sse".`);
    process.exitCode = 1;
  });

program
  .command('query <text>')
  .option('-k, --top-k <n>', 'top-k', '5')
  .option('-p, --port <n>', 'server port', '3000')
  .action(async (text, opts) => {
    const res = await fetch(`http://localhost:${opts.port}/mcp/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: text, topK: Number(opts.topK) })
    });
    if (!res.ok) {
      console.error(`Query failed with status ${res.status}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program.action(async () => {
  const cwd = process.cwd();
  const configPath = path.join(cwd, 'config.json');
  const skillsDir = path.join(cwd, 'skills');

  if (fs.existsSync(configPath)) {
    const config = loadConfig(configPath);
    await bootstrap(config);
    return;
  }

  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    const scanResults = scanDirectory(skillsDir);
    const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectormcp-'));
    const config = {
      ...DEFAULT_CONFIG,
      dataDir: tempDataDir,
      skillsDir,
      port: DEFAULT_CONFIG.port,
      sources: scanResults.toolFiles.map((file) => ({ type: 'file', path: file, category: 'general' }))
    };
    await bootstrap(config);
    console.log(`Found ${scanResults.skillCount} skills, ${scanResults.toolFiles.length} tool files. Server running on http://localhost:${config.port}`);
    return;
  }

  program.outputHelp();
});

program.parseAsync(process.argv);

function addSource(source) {
  const config = loadConfig();
  const id = source.path || source.url;
  const exists = config.sources.some((s) => (s.path || s.url) === id);
  if (exists) {
    console.log('Source already exists in config.');
    return;
  }
  config.sources.push(source);
  saveConfig(config);
  console.log(`Added ${source.type} source: ${id}`);
}


function addSkill(pathOrGitUrl) {
  const config = loadConfig();
  const installResult = installSkillFromSource(pathOrGitUrl, config.skillsDir || './skills');
  if (!installResult.ok) {
    console.error(installResult.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Skill added from ${installResult.sourceType}: ${installResult.destDir}`);
}

function installSkillFromSource(pathOrGitUrl, skillsDir) {
  fs.mkdirSync(skillsDir, { recursive: true });

  const isGitUrl = /^https?:\/\//.test(pathOrGitUrl) || /^git@/.test(pathOrGitUrl) || pathOrGitUrl.endsWith('.git');

  if (!isGitUrl) {
    const sourceDir = path.resolve(pathOrGitUrl);
    const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceSkillFile)) {
      return { ok: false, message: `SKILL.md not found in local folder: ${sourceDir}` };
    }

    const folderName = path.basename(sourceDir);
    const destDir = path.join(skillsDir, folderName);
    if (fs.existsSync(destDir)) {
      return { ok: false, message: `Skill destination already exists: ${destDir}` };
    }

    fs.cpSync(sourceDir, destDir, { recursive: true });
    return { ok: true, sourceType: 'local path', folderName, destDir };
  }

  const folderName = pathOrGitUrl.split('/').pop().replace(/\.git$/, '');
  const destDir = path.join(skillsDir, folderName);
  if (fs.existsSync(destDir)) {
    return { ok: false, message: `Skill destination already exists: ${destDir}` };
  }

  const clone = spawnSync('git', ['clone', '--depth', '1', pathOrGitUrl, destDir], { stdio: 'inherit' });
  if (clone.status !== 0) {
    return { ok: false, message: 'Failed to clone skill repository.' };
  }

  const skillFile = path.join(destDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fs.rmSync(destDir, { recursive: true, force: true });
    return { ok: false, message: 'Cloned repository does not contain SKILL.md at the root.' };
  }

  return { ok: true, sourceType: 'git', folderName, destDir };
}

function printTable(headers, rows) {
  const colWidths = headers.map((header, idx) => {
    const rowWidths = rows.map((row) => String(row[idx] || '').length);
    return Math.max(header.length, ...rowWidths);
  });

  const renderRow = (row) => row.map((value, idx) => String(value || '').padEnd(colWidths[idx])).join('  ');
  console.log(renderRow(headers));
  for (const row of rows) {
    console.log(renderRow(row));
  }
}

function addTrailingSlash(inputPath) {
  return inputPath.endsWith(path.sep) ? inputPath : `${inputPath}${path.sep}`;
}

function scanDirectory(rootDir) {
  const toolFiles = [];
  let skillCount = 0;
  walkDir(rootDir, (fullPath, entry) => {
    if (!entry.isFile()) return;

    if (entry.name === 'SKILL.md') {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (/^---\r?\n[\s\S]*?\r?\n---/m.test(content)) {
        skillCount += 1;
      }
      return;
    }

    if (entry.name.endsWith('.json')) {
      if (hasJsonToolDefinition(fullPath)) {
        toolFiles.push(fullPath);
      }
      return;
    }

    if (entry.name.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (/^##\s+/m.test(content)) {
        toolFiles.push(fullPath);
      }
    }
  });

  return { skillCount, toolFiles };
}

function hasJsonToolDefinition(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.some((entry) => entry && typeof entry === 'object' && entry.name && entry.description);
  } catch {
    return false;
  }
}

function walkDir(dir, onEntry) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist', 'data'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    onEntry(fullPath, entry);
    if (entry.isDirectory()) {
      walkDir(fullPath, onEntry);
    }
  }
}

function gatherWatchTargetsFromConfig(config) {
  const targets = new Set();
  const skillsDir = config.skillsDir || './skills';
  targets.add(path.resolve(skillsDir));

  for (const source of config.sources || []) {
    if (source.type !== 'file' || !source.path) continue;
    const fullPath = path.resolve(source.path);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      targets.add(stat.isDirectory() ? fullPath : path.dirname(fullPath));
    }
  }

  return [...targets].filter((target) => fs.existsSync(target));
}

function setupWatchers(pathsToWatch, onRebuild) {
  const watchedDirs = new Set();
  let rebuilding = false;
  let rebuildScheduled = false;

  const scheduleRebuild = () => {
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    setTimeout(async () => {
      rebuildScheduled = false;
      if (rebuilding) return;
      rebuilding = true;
      try {
        console.log('Detected changes, rebuilding index...');
        await onRebuild();
      } catch (error) {
        console.error(`Rebuild failed: ${error.message}`);
      } finally {
        rebuilding = false;
      }
    }, 200);
  };

  const watchDirectory = (dir) => {
    if (watchedDirs.has(dir) || !fs.existsSync(dir)) return;
    watchedDirs.add(dir);

    fs.watch(dir, { persistent: true }, (_eventType, filename) => {
      const changedPath = filename ? path.join(dir, filename.toString()) : null;
      if (changedPath && fs.existsSync(changedPath) && fs.statSync(changedPath).isDirectory()) {
        walkWatchTree(changedPath, watchDirectory);
      }
      scheduleRebuild();
    });
  };

  for (const rootPath of pathsToWatch) {
    if (!fs.existsSync(rootPath)) continue;
    walkWatchTree(rootPath, watchDirectory);
  }

  if (watchedDirs.size > 0) {
    console.log(`Watching ${watchedDirs.size} director${watchedDirs.size === 1 ? 'y' : 'ies'} for changes...`);
  }
}

function walkWatchTree(rootPath, watchDirectory) {
  const stat = fs.statSync(rootPath);
  if (stat.isDirectory()) {
    watchDirectory(rootPath);
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['.git', 'node_modules', 'dist', 'data'].includes(entry.name)) continue;
      walkWatchTree(path.join(rootPath, entry.name), watchDirectory);
    }
  } else {
    watchDirectory(path.dirname(rootPath));
  }
}
