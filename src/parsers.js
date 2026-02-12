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

function makeTool({ name, description, params = {}, source, category = 'general', invoke }) {
  const id = crypto.createHash('sha1').update(`${source}:${name}`).digest('hex').slice(0, 16);
  return { id, name, description, params, source, category, invoke };
}
