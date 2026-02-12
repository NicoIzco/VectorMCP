import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker } from '../src/analytics.js';
import { LocalEmbedder, SourceMeta, VectorStore } from '../src/core.js';

test('embedder returns fixed-dim vectors', () => {
  const emb = new LocalEmbedder(32);
  const vec = emb.embed('manage tasks and reminders');
  assert.equal(vec.length, 32);
});

test('vector search ranks similar tool first', () => {
  const emb = new LocalEmbedder(64);
  const store = new VectorStore('/tmp/vectormcp-index-test.json');
  store.items = [
    {
      id: 'a',
      vector: emb.embed('manage tasks todo reminders productivity'),
      tool: { id: 'a', name: 'task_manager' }
    },
    {
      id: 'b',
      vector: emb.embed('image generation art prompt'),
      tool: { id: 'b', name: 'art_tool' }
    }
  ];
  const [first] = store.search('help me manage my tasks', emb, 1);
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
