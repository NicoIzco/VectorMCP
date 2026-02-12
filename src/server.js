import express from 'express';
import { parseSource } from './parsers.js';
import { ensureDataDir, LocalEmbedder, ToolRegistry, VectorStore } from './core.js';

export async function bootstrap(config) {
  ensureDataDir(config.dataDir);
  const tools = new ToolRegistry(config.dataDir);
  tools.load();
  const embedder = new LocalEmbedder();
  const index = new VectorStore(`${config.dataDir}/index.json`);
  index.load();

  async function syncSource(source) {
    const parsed = await parseSource(source, config.dataDir);
    tools.removeBySource(source.path || source.url);
    tools.upsertMany(parsed);
    index.rebuild(tools.tools, embedder);
    return parsed.length;
  }

  async function syncAll() {
    for (const source of config.sources) {
      await syncSource(source);
    }
  }

  if (tools.tools.length === 0 && config.sources.length > 0) {
    await syncAll();
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, tools: tools.tools.length }));

  app.get('/mcp/tools', (_req, res) => {
    res.json({ tools: tools.tools.map(toMcpSchema) });
  });

  app.post('/mcp/query', (req, res) => {
    const query = req.body?.query || '';
    const topK = Number(req.body?.topK || config.topK || 5);
    const matches = index.search(query, embedder, topK);
    res.json({ query, matches });
  });

  app.post('/mcp/invoke', (req, res) => {
    const { toolId, args } = req.body || {};
    const tool = tools.tools.find((t) => t.id === toolId);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (tool.invoke.type === 'noop') {
      return res.json({ tool: tool.name, result: 'No-op tool registered', args });
    }
    return res.json({ tool: tool.name, result: 'Invocation proxy not yet implemented', args, invoke: tool.invoke });
  });

  app.post('/sources/sync', async (req, res) => {
    const target = req.body?.source;
    if (target) {
      const source = config.sources.find((s) => (s.path || s.url) === target);
      if (!source) return res.status(404).json({ error: 'Source not found' });
      const added = await syncSource(source);
      return res.json({ synced: 1, added });
    }
    await syncAll();
    return res.json({ synced: config.sources.length });
  });

  app.get('/dashboard', (_req, res) => {
    res.type('html').send(renderDashboard());
  });

  const server = app.listen(config.port, () => {
    console.log(`VectorMCP running on http://localhost:${config.port}`);
  });

  return { app, server, tools, index, syncAll };
}

function toMcpSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.params || {}
    },
    metadata: {
      toolId: tool.id,
      category: tool.category,
      source: tool.source
    }
  };
}

function renderDashboard() {
  return `<!doctype html>
<html>
  <head><title>VectorMCP Dashboard</title><style>
    body { font-family: Arial; margin: 2rem; max-width: 800px; }
    form, pre { background:#f6f8fa; padding:1rem; border-radius:8px; }
    input, button { padding:.5rem; margin:.3rem 0; width:100%; }
  </style></head>
  <body>
    <h1>VectorMCP Dashboard</h1>
    <form id="queryForm">
      <label>Test query</label>
      <input name="query" placeholder="manage tasks" />
      <button>Search</button>
    </form>
    <pre id="output">Run a query…</pre>
    <script>
      queryForm.onsubmit = async (e) => {
        e.preventDefault();
        const query = new FormData(queryForm).get('query');
        const res = await fetch('/mcp/query', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({query, topK:5})
        });
        output.textContent = JSON.stringify(await res.json(), null, 2);
      };
    </script>
  </body>
</html>`;
}
