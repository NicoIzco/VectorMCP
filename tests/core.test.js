import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker } from '../src/analytics.js';
import { LocalEmbedder, SourceMeta, VectorStore, cosineSimilarity } from '../src/core.js';
import { createEmbedder, normalizeEmbedderConfig } from '../src/embedders.js';

test('embedder returns fixed-dim vectors', async () => {
  const emb = new LocalEmbedder(32);
  const vec = await emb.embed('manage tasks and reminders');
  assert.equal(vec.length, 32);
});

test('vector search ranks similar tool first', async () => {
  const emb = new LocalEmbedder(64);
  const store = new VectorStore('/tmp/vectormcp-index-test.json');
  store.items = [
    {
      id: 'a',
      vector: await emb.embed('manage tasks todo reminders productivity'),
      tool: { id: 'a', name: 'task_manager' }
    },
    {
      id: 'b',
      vector: await emb.embed('image generation art prompt'),
      tool: { id: 'b', name: 'art_tool' }
    }
  ];
  const [first] = await store.search('help me manage my tasks', emb, 1);
  assert.equal(first.tool.id, 'a');
});

test('source meta persists and removes source details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectormcp-meta-'));
  const sourceMeta = new SourceMeta(dir);
  sourceMeta.load();

  sourceMeta.set('./skills.md', {
    status: 'synced',
    lastSync: '2025-01-15T10:30:00Z',
    toolCount: 5,
    error: null
  });

  const reloaded = new SourceMeta(dir);
  reloaded.load();
  assert.deepEqual(reloaded.get('./skills.md'), {
    status: 'synced',
    lastSync: '2025-01-15T10:30:00Z',
    toolCount: 5,
    error: null
  });

  reloaded.remove('./skills.md');
  assert.equal(reloaded.get('./skills.md'), null);
});

test('activity tracker aggregates query frequency and caps activity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectormcp-activity-'));
  const tracker = new ActivityTracker(dir);
  tracker.load();

  tracker.recordQuery('manage tasks');
  tracker.recordQuery('manage tasks');
  tracker.recordQuery('create image');
  const top = tracker.getQueryFrequency(10);

  assert.equal(top[0].text, 'manage tasks');
  assert.equal(top[0].count, 2);

  for (let i = 0; i < 60; i += 1) {
    tracker.recordEvent('query', `Query ${i}`);
  }

  const events = tracker.getActivity(100);
  assert.equal(events.length, 50);
  assert.equal(events[0].message, 'Query 59');
});

test('normalizeEmbedderConfig defaults to local', () => {
  assert.deepEqual(normalizeEmbedderConfig(undefined), { type: 'local' });
  assert.deepEqual(normalizeEmbedderConfig('minilm'), { type: 'minilm' });
  assert.deepEqual(normalizeEmbedderConfig({ type: 'minilm' }), {
    type: 'minilm',
    model: 'Xenova/all-MiniLM-L6-v2'
  });
});

test('createEmbedder factory defaults to local with dim 384', async () => {
  const embedder = await createEmbedder({});
  assert.equal(embedder.name, 'local');
  assert.equal(embedder.dim, 384);
  const vec = await embedder.embed('hello');
  assert.equal(vec.length, 384);
});

test('createEmbedder minilm-missing falls back to local with warning', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const embedder = await createEmbedder(
      { embedder: 'minilm' },
      { importModule: async () => { throw new Error('module not found'); } }
    );
    assert.equal(embedder.name, 'local');
    assert.equal(embedder.dim, 384);
    assert.match(warnings.join('\n'), /npm i @xenova\/transformers/);
  } finally {
    console.warn = originalWarn;
  }
});

test('rebuild-on-embedder-mismatch persists meta and matchesEmbedder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectormcp-index-'));
  const indexPath = path.join(dir, 'index.json');
  const store = new VectorStore(indexPath);

  const embedder8 = {
    name: 'fake',
    model: 'test-8',
    dim: 8,
    embed: async (text) => new Array(8).fill(String(text).length > 0 ? 1 : 0)
  };
  const embedder16 = {
    name: 'fake',
    model: 'test-16',
    dim: 16,
    embed: async (text) => new Array(16).fill(String(text).length > 0 ? 1 : 0)
  };

  const tools = [{ id: 't1', name: 'tool', description: 'desc', category: 'general' }];
  await store.rebuild(tools, embedder8);
  store.load();
  assert.equal(store.matchesEmbedder(embedder8), true);
  assert.equal(store.matchesEmbedder(embedder16), false);

  await store.rebuild(tools, embedder16);
  store.load();
  assert.equal(store.meta.dim, 16);
  assert.equal(store.matchesEmbedder(embedder16), true);
});

test('legacy bare-array index counts as embedder mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectormcp-legacy-'));
  const indexPath = path.join(dir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify([
    { id: 'a', vector: [1, 0, 0, 0], tool: { id: 'a', name: 'a' } }
  ]));

  const store = new VectorStore(indexPath);
  store.load();
  const embedder = { name: 'local', model: null, dim: 4, embed: async () => [1, 0, 0, 0] };
  assert.equal(store.matchesEmbedder(embedder), false);
});

test('cross-dim cosineSimilarity scores 0', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
});
