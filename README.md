# VectorMCP
**The semantic search engine for MCP tools and Claude Skills.**
VectorMCP helps you route the right MCP tool at the right time, without manually wiring dozens of servers.

- Tool sprawl is real: local files, repos, WebMCP servers, and skill folders get fragmented fast.
- User intent is fuzzy: queries like “handle customer churn” need semantic matching, not exact names.
- Zero-config workflow: run one command and get a searchable MCP tool router immediately.
- Works with Claude Desktop via MCP proxy mode (`stdio`) and web clients via SSE.

## Quick demo

```bash
npx vectormcp scan ./my-tools
# Found X skills, Y tool files. Server running on http://localhost:3000
```

That’s it: VectorMCP scans, indexes, and serves semantic search instantly.

## 🔍 Semantic Search

Use natural language to find tools by intent, not exact command names.

- Local embedding pipeline (no external API keys required).
- Cosine similarity ranking over indexed tools.
- Session-aware query behavior in REST mode.
- Skill-aware embeddings include richer context from `SKILL.md` metadata + body.

Example query:

```bash
npx vectormcp query "triage support tickets by priority"
```

## Embeddings

VectorMCP ships with a **deliberate zero-dependency default**: a local hash embedder that needs no network, no API keys, and starts instantly with deterministic output.

For higher-quality semantic matching, opt in to MiniLM:

```bash
npm i @xenova/transformers
```

Then set `"embedder": "minilm"` in `config.json`, or pass `--embedder minilm` to `start`, `proxy`, or `scan`. The first run downloads the model (~25 MB) and requires network access. If `@xenova/transformers` is unavailable, VectorMCP warns on stderr and falls back to the local embedder automatically. Switching embedders triggers a one-time index rebuild.

Configure embedders in shorthand or full form:

```json
{ "embedder": "local" }
```

```json
{ "embedder": { "type": "minilm", "model": "Xenova/all-MiniLM-L6-v2" } }
```

**Scaling:** search uses brute-force cosine similarity — O(N) per query, which is fine up to roughly 10k tools. `VectorStore` is the single seam where you could swap in FAISS or another ANN backend beyond that scale.

If model cache churn is an issue (e.g. on OneDrive-synced folders), set `TRANSFORMERS_CACHE` to a stable local path.

## 🔌 MCP Proxy

Run VectorMCP as an MCP middleware layer for Claude Desktop, Cursor, and compatible clients.

- `vectormcp proxy --transport stdio` for JSON-RPC 2.0 over stdio.
- `vectormcp proxy --transport sse --port 3000` for SSE transport.
- Full protocol coverage:
  - `initialize`
  - `tools/list` (with optional `contextHint` filtering)
  - `tools/call`
  - `completion/complete`

## 📦 Skill Registry

Discover and install community Claude Skills.

- Search the registry by keyword.
- Install by registry name (`@user/skill-name`) or git URL.
- Uninstall locally installed skills.
- List installed skills and publish workflow instructions.

Default `registryUrl` points to:
`https://raw.githubusercontent.com/NicoIzco/vectormcp-registry/main/registry.json`

## ⚡ Zero Config

Fastest path from folder to working semantic router:

- `npx vectormcp scan <dir>` auto-discovers skills and tool files, then starts server.
- `npx vectormcp` with no args picks an intelligent default:
  1. start from `config.json` if present,
  2. otherwise scan `./skills` if present,
  3. otherwise show help.
- `--watch` support on `scan` and `start` for live index rebuilds.

## 👁 Dashboard

Built-in dark-mode control panel at `GET /dashboard`.

- Manage sources (add/sync/remove).
- Browse indexed tool inventory.
- Run semantic queries visually.
- Inspect query and activity analytics.

## Quick start

### Path 1: Zero-config scan (fastest)

```bash
npx vectormcp scan ./my-tools
npx vectormcp query "summarize quarterly metrics"
```

Optional live reload:

```bash
npx vectormcp scan ./my-tools --watch
```

### Path 2: Claude Desktop integration (MCP stdio)

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "vectormcp": {
      "command": "npx",
      "args": ["vectormcp", "proxy", "--transport", "stdio"]
    }
  }
}
```

Then run:

```bash
npx vectormcp proxy --transport stdio
```

See `docs/claude-desktop.md` for details.

### Path 3: Full setup with `config.json`

```bash
npx vectormcp init
npx vectormcp add-file ./tools.md
npx vectormcp add-repo https://github.com/your-org/tools-repo
npx vectormcp add-web https://example.com/mcp
npx vectormcp add-skill ./skills/my-skill
npx vectormcp start --watch
```

## Source types

VectorMCP can ingest tools from multiple source modes:

- `file` — local `.md` or `.json` tool definitions.
- `repo` — git repositories containing tool files.
- `webmcp` — live MCP endpoints discovered from web-accessible servers.
- `skill` — Claude Skills (`SKILL.md` with YAML frontmatter) loaded from `skillsDir`.

## CLI reference

| Command | Description |
| --- | --- |
| `vectormcp scan <dir>` | Scan directory and start server |
| `vectormcp start` | Start from `config.json` |
| `vectormcp proxy` | MCP protocol proxy mode |
| `vectormcp search <q>` | Search skill registry |
| `vectormcp install <name>` | Install a skill |
| `vectormcp uninstall <name>` | Remove a skill |
| `vectormcp list` | List installed skills |
| `vectormcp publish` | Publish a skill |
| `vectormcp add-file <path>` | Add a file source |
| `vectormcp add-repo <url>` | Add a git repo source |
| `vectormcp add-web <url>` | Add a WebMCP source |
| `vectormcp add-skill <path>` | Add a Claude Skill folder |
| `vectormcp query <text>` | Query the running server |
| `vectormcp init` | Create default `config.json` |

Useful flags:

- `vectormcp start --watch`
- `vectormcp scan <dir> --watch`
- `vectormcp proxy --transport stdio|sse --port 3000`
- `vectormcp start --embedder minilm`
- `vectormcp proxy --embedder local|minilm`

## Skill format (`SKILL.md`)

VectorMCP supports Claude Skill folders directly.

```md
---
name: ticket-triage
version: 1.0.0
description: Prioritize and route support tickets with clear escalation rules.
category: support
---

## Instructions
- Classify urgency as low, medium, high.
- Ask for missing context before escalation.
- Output actionable next steps as bullet points.
```

Example structure:

```text
skills/
  ticket-triage/
    SKILL.md
```

## API reference

### Core MCP REST

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check + indexed tool count |
| `GET` | `/mcp/tools` | List MCP tool schemas |
| `POST` | `/mcp/query` | Semantic retrieval (`query`, `topK`, optional `sessionId`) |
| `POST` | `/mcp/invoke` | Invoke tool by `toolId` |

### Source management

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/sources/add` | Add a source (`file`, `repo`, `webmcp`) |
| `POST` | `/sources/sync` | Sync one source or all sources |
| `DELETE` | `/sources/remove` | Remove source |
| `GET` | `/sources/list` | List configured sources + sync status |

### Analytics + UI

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/analytics/queries` | Query analytics history |
| `GET` | `/analytics/activity` | Activity/event feed |
| `GET` | `/dashboard` | Built-in dashboard UI |

## Architecture

VectorMCP’s retrieval flow is intentionally simple and local-first:

1. Parse tools from configured sources and skill folders.
2. Build vectors with the configured embedder (local hash by default, optional MiniLM).
3. Store vectors in `VectorStore` with embedder metadata for invalidation on switch.
4. Score query-to-tool similarity with cosine similarity.
5. Return ranked tools for MCP listing, completion, or query responses.

Core components:

- `LocalEmbedder` / MiniLM — pluggable embedding backends (`src/embedders.js`).
- `VectorStore` — indexed vectors + search with embedder-aware persistence.
- `ToolRegistry` — JSON storage with upsert/dedup behavior.
- MCP transport layer — stdio or SSE for protocol clients.

### Notes

- Default embeddings are local hash vectors (fast, zero dependencies, no external service). MiniLM is an optional upgrade via `npm i @xenova/transformers`.
- WebMCP extraction uses Playwright when available.
- Repo parsing targets Markdown/JSON tool definitions.

## Contributing

Issues and PRs are welcome.

- Improve source parsers
- Extend MCP interoperability
- Add skill ecosystem tooling
- Refine retrieval quality while preserving local-first behavior

## License

MIT
