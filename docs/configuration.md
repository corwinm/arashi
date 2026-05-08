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
      "launch": true
    },
    "editors": {
      "vscode": {
        "create": {
          "launch": true,
          "launchMode": "sesh"
        }
      }
    },
    "switch": {
      "mode": "auto",
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

### `defaults.editors.<host>.create`

Supported hosts: `vscode`, `cursor`, `kiro`

- `switch` (boolean): host-specific auto-switch behavior after create
- `launch` (boolean): host-specific launch behavior after create
- `launchMode` (`auto` | `sesh`): preferred launch mode for that editor host

Use editor-scoped defaults when terminal `arashi create` should behave one way, but extension-driven create should behave differently.

Example:

```json
{
  "defaults": {
    "create": {
      "switch": true,
      "launch": false
    },
    "editors": {
      "vscode": {
        "create": {
          "launch": true,
          "launchMode": "sesh"
        }
      }
    }
  }
}
```

In that configuration, terminal `arashi create` uses `defaults.create`, while VS Code extension `create` uses `defaults.editors.vscode.create`. If an editor-hosted create invocation has no matching host override, Arashi applies no post-create defaults unless the user passes explicit CLI flags.

### `defaults.switch`

- `mode` (`launch` | `cd` | `auto`): preferred switch behavior for `arashi switch`
- `launchMode` (`auto` | `sesh`): preferred launch mode for `arashi switch`

Use `mode: "launch"` to preserve launcher-only behavior, `mode: "cd"` to request parent-shell directory switching by default, or `mode: "auto"` to prefer `cd` only when shell integration is active.

Enable shell integration with:

```bash
arashi shell install
```

If you prefer manual setup, print shell-specific wrapper code with `arashi shell init <bash|zsh|fish>`.

## Precedence Rules

Arashi resolves defaults in this order:

1. Explicit CLI flag
2. Explicit opt-out flag
3. Configured default
4. Built-in default

Examples:

- `arashi create feature-auth --launch` overrides config to force launch for that run.
- `arashi create feature-auth --no-launch` disables configured create launch defaults for that run.
- Extension-driven `arashi create` uses `defaults.editors.<host>.create` when present and otherwise skips post-create defaults.
- `arashi switch feature-auth --cd` overrides config to request parent-shell directory switching for that run.
- `arashi switch feature-auth --no-cd` forces launch behavior for that run even when switch defaults prefer `cd`.
- `arashi switch --no-default-launch` bypasses configured switch launch mode defaults for that run.
