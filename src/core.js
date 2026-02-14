import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_CONFIG = {
  dataDir: './data',
  skillsDir: './skills',
  registryUrl: 'https://raw.githubusercontent.com/NicoIzco/vectormcp-registry/main/registry.json',
  port: 3000,
  topK: 5,
  sources: []
};

export function loadConfig(configPath = 'config.json') {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function saveConfig(config, configPath = 'config.json') {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export class LocalEmbedder {
  constructor(dim = 384) {
    this.dim = dim;
  }

  embed(text) {
    const vec = new Array(this.dim).fill(0);
    const words = String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
    if (words.length === 0) return vec;
    for (const word of words) {
      const hash = crypto.createHash('sha256').update(word).digest();
      const idx = hash.readUInt16BE(0) % this.dim;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export class VectorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = [];
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    this.items = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2));
  }

  rebuild(tools, embedder) {
    this.items = tools.map((tool) => ({
      id: tool.id,
      vector: embedder.embed(buildEmbeddingInput(tool)),
      tool
    }));
    this.save();
  }

  search(query, embedder, topK = 5) {
    const q = embedder.embed(query);
    const scored = this.items
      .map((item) => ({
        score: cosineSimilarity(q, item.vector),
        tool: item.tool
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored;
  }
}

function buildEmbeddingInput(tool) {
  if (tool.skillFormat === true) {
    return [tool.name, tool.description, tool.category || '', extractKeyLines(tool.markdownBody)].join(' | ');
  }
  return [tool.name, tool.description, tool.category].join(' ');
}

function extractKeyLines(markdown) {
  return String(markdown || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

export class ToolRegistry {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'tools.json');
    this.tools = [];
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      this.tools = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.tools, null, 2));
  }

  upsertMany(inputTools) {
    const byId = new Map(this.tools.map((t) => [t.id, t]));
    for (const t of inputTools) byId.set(t.id, t);
    this.tools = [...byId.values()];
    this.save();
  }

  removeBySource(source) {
    this.tools = this.tools.filter((t) => t.source !== source && !String(t.source || '').startsWith(`${source}#`));
    this.save();
  }
}

export class SourceMeta {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'source-meta.json');
    this.meta = {};
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      this.meta = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.meta, null, 2));
  }

  set(sourceId, details) {
    this.meta[sourceId] = {
      lastSync: details.lastSync ?? null,
      toolCount: Number(details.toolCount || 0),
      status: details.status || 'idle',
      error: details.error ?? null
    };
    this.save();
  }

  get(sourceId) {
    return this.meta[sourceId] || null;
  }

  remove(sourceId) {
    delete this.meta[sourceId];
    this.save();
  }
}
