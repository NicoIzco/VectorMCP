# VectorMCP Registry Setup

This guide explains how to set up a GitHub-backed skill registry for VectorMCP.

## 1. Create a repository

1. Create a new repository, for example: `vectormcp-registry`.
2. Commit a `registry.json` file at the repository root.
3. Enable contributions through pull requests.

## 2. Add the registry index

The `registry.json` file should contain an array of skill entries:

```json
[
  {
    "name": "@user/skill-name",
    "repo": "https://github.com/user/skill-repo",
    "description": "Short description",
    "version": "1.0.0",
    "tags": ["category", "topic"]
  }
]
```

## 3. Use the raw GitHub URL in VectorMCP

The default value in `config.json` is:

```json
{
  "registryUrl": "https://raw.githubusercontent.com/NicoIzco/vectormcp-registry/main/registry.json"
}
```

To use your own registry, point `registryUrl` to your repo's raw `registry.json` URL.

## 4. Contribution flow

1. Skill authors fork the registry repository.
2. Add a new entry in `registry.json`.
3. Open a pull request with the new skill details.
4. Maintainers review and merge.

No backend service is required; VectorMCP reads directly from GitHub.
