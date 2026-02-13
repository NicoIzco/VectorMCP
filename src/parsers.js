import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { simpleGit } from 'simple-git';

export async function parseSource(source, dataDir) {
  if (source.type === 'file') return parseFileSource(source);
  if (source.type === 'repo') return parseRepoSource(source, dataDir);
  if (source.type === 'webmcp') return parseWebMCPSource(source);
  return [];
}

export function parseSkillsDir(skillsDir) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];
  const folders = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const tools = [];

  for (const folder of folders) {
    const skillPath = path.join(skillsDir, folder.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const displayPath = `skills/${folder.name}/SKILL.md`;
    if (!match) {
      console.warn(`⚠ No YAML frontmatter in ${displayPath} — skipping`);
      continue;
    }

    const frontmatter = parseSimpleYaml(match[1]);
    if (!frontmatter.name) {
      console.warn(`⚠ Missing required "name" in ${displayPath} — skipping`);
      continue;
    }
    if (!frontmatter.description) {
      console.warn(`⚠ Missing required "description" in ${displayPath} — skipping`);
      continue;
    }

    const markdownBody = content.slice(match[0].length).trim();
    const sourcePath = path.relative(process.cwd(), skillPath).split(path.sep).join('/').replace(/^\.\//, '');
    tools.push(
      makeTool({
        name: frontmatter.name,
        description: frontmatter.description,
        source: sourcePath,
        category: frontmatter.category || 'general',
        invoke: { type: 'skill' },
        version: frontmatter.version || null,
        dependencies: Array.isArray(frontmatter.dependencies) ? frontmatter.dependencies : [],
        markdownBody,
        skillFormat: true
      })
    );
  }

  return tools;
}

function parseMarkdownSkills(content, sourceName, category) {
  const blocks = content.split(/^##\s+/m).slice(1);
  return blocks.map((block) => {
    const [titleLine, ...body] = block.split('\n');
    const description = body.join('\n').trim().slice(0, 300);
    const name = titleLine.trim();
    return makeTool({ name, description, source: sourceName, category, invoke: { type: 'noop' } });
  });
}

function parseJsonSkills(content, sourceName, category) {
  const parsed = JSON.parse(content);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map((entry) =>
    makeTool({
      name: entry.name,
      description: entry.desc || entry.description || 'No description',
      params: entry.params || {},
      source: sourceName,
      category,
      invoke: entry.invoke || { type: 'noop' }
    })
  );
}

function parseFileSource(source) {
  const content = fs.readFileSync(source.path, 'utf8');
  if (source.path.endsWith('.json')) {
    return parseJsonSkills(content, source.path, source.category);
  }
  return parseMarkdownSkills(content, source.path, source.category);
}

async function parseRepoSource(source, dataDir) {
  const repoName = source.url.split('/').pop().replace(/\.git$/, '');
  const repoPath = path.join(dataDir, 'repos', repoName);
  fs.mkdirSync(path.dirname(repoPath), { recursive: true });
  const git = simpleGit();
  if (!fs.existsSync(repoPath)) {
    await git.clone(source.url, repoPath, ['--depth', '1']);
  } else {
    await simpleGit(repoPath).pull();
  }
  const files = scanFiles(repoPath, ['.md', '.json']);
  return files.flatMap((file) => {
    const rel = path.relative(repoPath, file);
    const content = fs.readFileSync(file, 'utf8');
    const sourceName = `${source.url}#${rel}`;
    return file.endsWith('.json')
      ? parseJsonSkills(content, sourceName, source.category)
      : parseMarkdownSkills(content, sourceName, source.category);
  });
}

async function parseWebMCPSource(source) {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const tools = await page.evaluate(() => {
      const mcp = globalThis.navigator?.modelContext;
      return mcp?.tools?.map((t) => ({ name: t.name, description: t.description, params: t.inputSchema })) || [];
    });
    await browser.close();
    return tools.map((t) =>
      makeTool({
        name: t.name,
        description: t.description || 'WebMCP-discovered tool',
        params: t.params || {},
        source: source.url,
        category: source.category,
        invoke: { type: 'webmcp', url: source.url, tool: t.name }
      })
    );
  } catch {
    return [];
  }
}

function scanFiles(dir, exts) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !['.git', 'node_modules', 'dist'].includes(entry.name)) {
      out.push(...scanFiles(full, exts));
    }
    if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function parseSimpleYaml(frontmatter) {
  const parsed = {};
  let currentKey = null;
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ')) {
      if (currentKey === 'dependencies') {
        parsed.dependencies.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      }
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      currentKey = null;
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'dependencies') {
      parsed.dependencies = value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
      currentKey = 'dependencies';
      continue;
    }
    parsed[key] = value.replace(/^['"]|['"]$/g, '');
    currentKey = null;
  }
  return parsed;
}

function makeTool({ name, description, params = {}, source, category = 'general', invoke, version = null, dependencies = [], markdownBody = '', skillFormat = false }) {
  const id = crypto.createHash('sha1').update(`${source}:${name}`).digest('hex').slice(0, 16);
  return { id, name, description, params, source, category, invoke, version, dependencies, markdownBody, skillFormat };
}
