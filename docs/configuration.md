# Configuration

Arashi stores workspace settings in `.arashi/config.json`.

The personal managed-ignore preference is deliberately not stored in that shared file. Safe
configured `reposDir` and `worktreesDir` paths default to repository-local Git excludes. Select a
different clone-local policy with:

```bash
arashi init --ignore-scope local    # default; remove any stored override
arashi init --ignore-scope tracked  # maintain an owned block in .gitignore
arashi init --ignore-scope none     # report only; manage ignore rules manually
```

Git's effective tracked, repository-local, or existing global rule always takes precedence, and
Arashi does not write global Git configuration. Lifecycle commands (`pull`, `clone`, `add`, and
`create`) reuse the stored preference and reconcile before materializing configured paths.

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
      "mode": "sesh"
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
- `launchMode` (`auto` | `sesh` | `herdr`): preferred launch mode when launch is enabled

Create defaults are unchanged by the unified switch mode. `defaults.create.launchMode` remains independent and supported.

### `defaults.editors.<host>.create`

Supported hosts: `vscode`, `cursor`, `kiro`

- `switch` (boolean): host-specific auto-switch behavior after create
- `launch` (boolean): host-specific launch behavior after create
- `launchMode` (`auto` | `sesh` | `herdr`): preferred launch mode for that editor host

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

- `mode` (`auto` | `cd` | `launch` | `sesh` | `herdr`): the single switch behavior and launcher choice

Use `launch` for automatic launcher selection without preferring parent-shell switching, `cd` to request parent-shell switching, `sesh` or `herdr` to force that launcher, and `auto` for contextual selection. Contextual `auto` checks strict managed contexts in the order tmux → Herdr → cmux → integrated IDE. When no managed context is detected, it uses `cd` if shell integration is active; otherwise it continues through terminal and platform launch fallback.

When `defaults.switch.mode` is absent, Arashi preserves the built-in `launch` behavior. Existing configurations therefore do not newly prefer `cd` merely because shell integration is installed.

Herdr automatic detection requires `HERDR_ENV` to normalize exactly to `1`. Herdr requires a Git-resolvable non-bare main checkout and a reachable default Herdr server/socket.

Enable shell integration with:

```bash
arashi shell install
```

If you prefer manual setup, print shell-specific wrapper code with `arashi shell init <bash|zsh|fish>`.

## Legacy switch configuration migration

The switch-only `launchMode` and `launch_mode` fields are accepted for a bounded compatibility window but are no longer in the canonical schema. Migrate them to one `defaults.switch.mode` value:

| Legacy `mode`              | Legacy launch field                 | Unified `mode`                                 |
| -------------------------- | ----------------------------------- | ---------------------------------------------- |
| absent                     | absent                              | absent (built-in `launch`)                     |
| absent / `launch`          | `auto`                              | `launch`                                       |
| absent / `launch` / `auto` | `sesh` / `herdr`                    | Matching explicit mode                         |
| `auto`                     | absent / `auto`                     | `auto`                                         |
| `cd`                       | absent / `auto`                     | `cd`                                           |
| `cd`                       | `sesh` / `herdr`                    | Rejected; choose `cd` or the explicit launcher |
| `sesh` / `herdr`           | absent / `auto` / matching launcher | Preserve the unified explicit mode             |
| `sesh` / `herdr`           | different explicit launcher         | Rejected as conflicting                        |

Equal `launchMode` and `launch_mode` aliases collapse to one value; different aliases are rejected. Accepted legacy fields emit one warning with the exact guidance `use defaults.switch.mode: "<replacement>" instead`. Migration warnings are written to stderr, so JSON stdout remains one structured document. Rejected combinations name the conflicting fields and values and stop before target selection or mutation.

## Precedence Rules

For `arashi switch`, the effective order is: Explicit launcher flags > `--cd` / `--no-cd` > configured mode > automatic context detection. Conflicting explicit launchers, or `--cd` combined with any explicit launcher, are rejected before switching.

`--tmux` is a per-invocation explicit launcher for both `switch` and `create`; it is not part of either persisted mode vocabulary. It requires `TMUX` to be non-empty after trimming and does not fall back when the prerequisite or tmux subprocess fails. For switch, `--tmux` conflicts with `--cd`, `--sesh`, `--herdr`, `--vscode`, `--cursor`, and `--kiro`; `--tmux` + `--no-cd` and `--tmux` + `--no-default-launch` remain valid because the explicit launcher wins. For create, `--tmux` conflicts with `--sesh` and `--herdr`, implies launch and switch, and overrides `--no-launch` and `--no-switch`. JSON mode rejects explicit tmux before conflict or context validation and before mutation.

Across command defaults generally, Arashi resolves values in this order:

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
- `arashi switch --no-default-launch` bypasses a configured `sesh` or `herdr` mode for that run; it does not erase configured `auto`, `cd`, or `launch` behavior.
