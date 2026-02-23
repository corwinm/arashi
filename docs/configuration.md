# Configuration

Arashi stores workspace settings in `.arashi/config.json`.

To enable JSON validation and editor autocomplete, include a `$schema` property:

```json
{
  "$schema": "https://unpkg.com/arashi/schema/config.schema.json",
  "version": "1.0.0",
  "reposDir": "./repos",
  "defaults": {
    "create": {
      "switch": true,
      "launch": true,
      "launchMode": "sesh"
    },
    "switch": {
      "launchMode": "sesh"
    }
  },
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
- `repos`
- `gitUrl`

Legacy snake_case keys are still accepted when loading existing workspaces, and Arashi rewrites them to canonical camelCase when the config is saved.

## Command Defaults

You can set command-scoped defaults under `defaults`.

### `defaults.create`

- `switch` (boolean): default auto-switch behavior after create
- `launch` (boolean): default launch behavior after create
- `launchMode` (`auto` | `sesh`): preferred launch mode when launch is enabled

### `defaults.switch`

- `launchMode` (`auto` | `sesh`): preferred launch mode for `arashi switch`

## Precedence Rules

Arashi resolves defaults in this order:

1. Explicit CLI flag
2. Explicit opt-out flag
3. Configured default
4. Built-in default

Examples:

- `arashi create feature-auth --launch` overrides config to force launch for that run.
- `arashi create feature-auth --no-launch` disables configured create launch defaults for that run.
- `arashi switch --no-default-launch` bypasses configured switch launch mode defaults for that run.
