# VectorMCP

VectorMCP is a lightweight local MCP backend that aggregates tools from Git repos, skill files, and WebMCP-compatible websites, then serves semantic search over one endpoint.

## Why

- Avoid tool overload by collecting scattered tools into one registry.
- Resolve fuzzy intent (`"manage tasks"`) with vector similarity.
- Run locally by default (no API key required).

## Quick start

```bash
npm install
npm start
```

Or with CLI:

```bash
npx vectormcp init
npx vectormcp add-file ./skills.md --category productivity
npx vectormcp start
```

## Core endpoints

- `GET /mcp/tools`: list MCP schemas
- `POST /mcp/query`: semantic retrieve (`{ query, topK }`)
- `POST /mcp/invoke`: invoke by `toolId`
- `GET /dashboard`: minimal control panel

## Example skill files

Markdown:

```md
## Summarize text
Condense long text into key bullets.
```

JSON:

```json
[
  {
    "name": "process_csv",
    "desc": "Analyze CSV rows and output grouped metrics",
    "params": {
      "path": { "type": "string" }
    }
  }
]
```


## Claude Skills (SKILL.md)

VectorMCP natively supports the Claude Skills format. Drop skill folders into `./skills/`:

```text
skills/
  my-task-skill/
    SKILL.md
  another-skill/
    SKILL.md
```

Each `SKILL.md` must have YAML frontmatter with `name` and `description`:

```yaml
---
name: my-task-skill
description: Helps the user manage project tasks with structured checklists
category: productivity
version: 1.0.0
---
## Guidelines
- Always create tasks as checkboxes
- Group by priority
```

VectorMCP will auto-discover, parse, and index these skills for semantic search. They appear in `/mcp/tools` and `/mcp/query` results with `skillFormat: true` in metadata.

Add a skill from git:

```bash
npx vectormcp add-skill https://github.com/user/my-skill-repo
```

## Notes

- Current embeddings are local hash vectors for zero-dependency startup.
- WebMCP extraction uses Playwright when available.
- Repo parsing scans `.md` and `.json` skill definitions.
