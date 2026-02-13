#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { bootstrap } from './server.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from './core.js';

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
  const skillsDir = config.skillsDir || './skills';
  fs.mkdirSync(skillsDir, { recursive: true });

  const isGitUrl = /^https?:\/\//.test(pathOrGitUrl) || /^git@/.test(pathOrGitUrl) || pathOrGitUrl.endsWith('.git');

  if (!isGitUrl) {
    const sourceDir = path.resolve(pathOrGitUrl);
    const sourceSkillFile = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceSkillFile)) {
      console.error(`SKILL.md not found in local folder: ${sourceDir}`);
      process.exitCode = 1;
      return;
    }

    const destDir = path.join(skillsDir, path.basename(sourceDir));
    if (fs.existsSync(destDir)) {
      console.error(`Skill destination already exists: ${destDir}`);
      process.exitCode = 1;
      return;
    }

    fs.cpSync(sourceDir, destDir, { recursive: true });
    console.log(`Skill added from local path: ${destDir}`);
    return;
  }

  const repoName = pathOrGitUrl.split('/').pop().replace(/\.git$/, '');
  const destDir = path.join(skillsDir, repoName);
  if (fs.existsSync(destDir)) {
    console.error(`Skill destination already exists: ${destDir}`);
    process.exitCode = 1;
    return;
  }

  const clone = spawnSync('git', ['clone', '--depth', '1', pathOrGitUrl, destDir], { stdio: 'inherit' });
  if (clone.status !== 0) {
    console.error('Failed to clone skill repository.');
    process.exitCode = 1;
    return;
  }

  const skillFile = path.join(destDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fs.rmSync(destDir, { recursive: true, force: true });
    console.error('Cloned repository does not contain SKILL.md at the root.');
    process.exitCode = 1;
    return;
  }

  console.log(`Skill added from git: ${destDir}`);
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
