# Configuration

Arashi stores workspace settings in `.arashi/config.json`.

To enable JSON validation and editor autocomplete, include a `$schema` property:

```json
{
  "$schema": "https://unpkg.com/arashi/schema/config.schema.json",
  "version": "1.0.0",
  "reposDir": "./repos",
  "autoSetup": true,
  "repos": {}
}
```

## Schema URLs

- Stable schema URL: `https://unpkg.com/arashi/schema/config.schema.json`
- Version-pinned schema URL: `https://unpkg.com/arashi@1.7.0/schema/config.schema.json`

Use the stable URL for normal workflows, and the version-pinned URL when you want schema behavior to stay fixed for a specific release.

## Canonical Key Format

Newly written config files use camelCase keys:

- `reposDir`
- `autoSetup`
- `repos`
- `gitUrl`
- `preCreate` / `postCreate`

Legacy snake_case keys are still accepted when loading existing workspaces, and Arashi rewrites them to canonical camelCase when the config is saved.
