import express from 'express';
import { parseSource, parseSkillsDir } from './parsers.js';
import { ensureDataDir, LocalEmbedder, ToolRegistry, VectorStore } from './core.js';
import { toMcpSchema } from './server.js';

export async function createMcpProxy(config) {
  ensureDataDir(config.dataDir);

  const tools = new ToolRegistry(config.dataDir);
  tools.load();
  const embedder = new LocalEmbedder();
  const index = new VectorStore(`${config.dataDir}/index.json`);
  index.load();

  async function syncAllSources() {
    for (const source of config.sources || []) {
      const sourceId = source.path || source.url;
      const parsed = await parseSource(source, config.dataDir);
      tools.removeBySource(sourceId);
      tools.upsertMany(parsed);
    }
    const skillTools = parseSkillsDir(config.skillsDir || './skills');
    const nonSkillTools = tools.tools.filter((tool) => !tool.skillFormat);
    tools.tools = [...nonSkillTools, ...skillTools];
    tools.save();
    index.rebuild(tools.tools, embedder);
  }

  if ((config.sources || []).length > 0 || tools.tools.length === 0) {
    await syncAllSources();
  }

  function findTool({ name, toolId }) {
    if (toolId) {
      const byId = tools.tools.find((tool) => tool.id === toolId);
      if (byId) return byId;
    }
    return tools.tools.find((tool) => tool.name === name) || null;
  }

  async function callTool(tool, args = {}) {
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: 'Tool not found.' }] };
    }

    if (tool.invoke?.type === 'noop' || tool.invoke?.type === 'skill') {
      return {
        content: [{ type: 'text', text: `Tool ${tool.name} is registered but not remotely invokable.` }],
        metadata: { toolId: tool.id }
      };
    }

    if (tool.invoke?.type === 'webmcp' && tool.invoke?.url) {
      try {
        const response = await fetch(tool.invoke.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'tools/call', params: { name: tool.invoke.tool || tool.name, arguments: args } })
        });

        const text = await response.text();
        return {
          content: [{ type: 'text', text: text || `Upstream ${tool.invoke.url} returned an empty body.` }],
          metadata: { status: response.status, upstream: tool.invoke.url }
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Upstream call failed: ${error.message}` }] };
      }
    }

    if (tool.invoke?.url) {
      try {
        const response = await fetch(tool.invoke.url, {
          method: tool.invoke.method || 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: tool.name, args })
        });
        return {
          content: [{ type: 'text', text: await response.text() }],
          metadata: { status: response.status, upstream: tool.invoke.url }
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Proxy call failed: ${error.message}` }] };
      }
    }

    return {
      isError: true,
      content: [{ type: 'text', text: `Unsupported invoke type: ${tool.invoke?.type || 'unknown'}` }]
    };
  }

  async function handleRpc(request) {
    const { id, method, params = {} } = request || {};

    const isNotification = id === undefined;
    const success = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const failure = (code, message, data) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

    if (!method) return failure(-32600, 'Invalid Request');

    if (method === 'initialize') {
      return success({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'vectormcp', version: '0.1.0' },
        capabilities: {
          tools: { listChanged: false },
          completion: {}
        }
      });
    }

    if (method === 'tools/list') {
      const contextHint = String(params.contextHint || '').trim();
      let selectedTools = tools.tools;

      if (contextHint) {
        const topK = Number(params.topK || 10);
        selectedTools = index.search(contextHint, embedder, topK).map((match) => match.tool);
      }

      return success({ tools: selectedTools.map(toMcpSchema) });
    }

    if (method === 'tools/call') {
      const tool = findTool({
        name: params.name,
        toolId: params.metadata?.toolId || params.toolId
      });
      const args = params.arguments || {};
      const result = await callTool(tool, args);
      return success(result);
    }

    if (method === 'completion/complete') {
      const text = [params.prompt, params.context, params.input, params.messages?.map((m) => m.content || '').join(' ')].filter(Boolean).join(' ');
      const topK = Number(params.topK || 10);
      const candidates = text ? index.search(text, embedder, topK) : tools.tools.slice(0, topK).map((tool) => ({ tool, score: 0 }));
      const suggestions = candidates.map((match) => ({
        tool: toMcpSchema(match.tool),
        score: match.score
      }));
      return success({ completion: suggestions });
    }

    return failure(-32601, `Method not found: ${method}`);
  }

  return {
    handleRpc,
    syncAllSources,
    transport: {
      startStdio() {
        startStdioTransport(handleRpc);
      },
      startSse(port = 3000) {
        return startSseTransport(handleRpc, port);
      }
    }
  };
}

function startStdioTransport(handleRpc) {
  const state = { buffer: '' };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    state.buffer += chunk;
    const messages = parseStdioMessages(state);
    for (const message of messages) {
      const response = await handleRpc(message);
      if (response === null) continue;
      writeStdioMessage(response);
    }
  });
}


function writeStdioMessage(message) {
  const body = JSON.stringify(message);
  const len = Buffer.byteLength(body, 'utf8');
  process.stdout.write(`Content-Length: ${len}\r\n\r\n${body}`);
}

function parseStdioMessages(state) {
  const messages = [];

  while (state.buffer.length > 0) {
    if (state.buffer.startsWith('Content-Length:')) {
      const headerEnd = state.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = state.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        state.buffer = '';
        break;
      }
      const bodyStart = headerEnd + 4;
      const length = Number(lengthMatch[1]);
      if (state.buffer.length < bodyStart + length) break;
      const body = state.buffer.slice(bodyStart, bodyStart + length);
      state.buffer = state.buffer.slice(bodyStart + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // ignore invalid messages
      }
      continue;
    }

    const newlineIndex = state.buffer.indexOf('\n');
    if (newlineIndex === -1) break;
    const line = state.buffer.slice(0, newlineIndex).trim();
    state.buffer = state.buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // ignore invalid messages
    }
  }

  return messages;
}

function startSseTransport(handleRpc, port) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const clients = new Set();

  app.get('/mcp/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write('event: ready\ndata: {"ok":true}\n\n');
    clients.add(res);

    req.on('close', () => {
      clients.delete(res);
    });
  });

  app.post('/mcp/sse', async (req, res) => {
    const response = await handleRpc(req.body);
    const payload = `event: message\ndata: ${JSON.stringify(response)}\n\n`;

    for (const client of clients) {
      client.write(payload);
    }

    res.json(response);
  });

  return app.listen(port, () => {
    console.log(`VectorMCP MCP proxy SSE running on http://localhost:${port}/mcp/sse`);
  });
}
