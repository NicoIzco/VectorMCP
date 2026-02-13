#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { bootstrap } from './server.js';
import { loadConfig, saveConfig } from './core.js';

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
  .action(async ({ config: configPath }) => {
    if (!fs.existsSync(configPath)) {
      console.error(`Config not found: ${configPath}. Run \`vectormcp init\` first.`);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig(configPath);
    await bootstrap(config);
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
