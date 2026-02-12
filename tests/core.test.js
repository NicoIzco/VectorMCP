import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalEmbedder, VectorStore } from '../src/core.js';

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
