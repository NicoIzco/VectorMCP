# VectorMCP Skill Registry

Community registry for discoverable VectorMCP skills.

## How it works

- This repository stores a single `registry.json` index.
- Skills are hosted in each author's own git repository.
- VectorMCP users can discover and install skills with:
  - `vectormcp search <query>`
  - `vectormcp install @user/skill-name`

## Adding a skill

1. Fork this repository.
2. Edit `registry.json` and add your skill entry:

```json
{
  "name": "@user/skill-name",
  "repo": "https://github.com/user/skill-repo",
  "description": "What your skill does",
  "version": "1.0.0",
  "tags": ["tag1", "tag2"]
}
```

3. Open a pull request.

## Contribution guidelines

- `name` must be unique.
- `repo` must be publicly accessible and include `SKILL.md` at the root.
- Keep descriptions concise and accurate.
- Use meaningful tags for searchability.

## Validation checklist

- [ ] JSON is valid.
- [ ] Skill repository URL is correct.
- [ ] `SKILL.md` includes frontmatter with `name` and `description`.
