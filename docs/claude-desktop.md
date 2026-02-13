# Claude Desktop MCP Configuration

Add the following snippet to your Claude Desktop config file to register VectorMCP as a single MCP server endpoint.

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

This starts VectorMCP in MCP proxy mode over stdio so Claude Desktop can connect directly.
