# Configuration

Arashi stores workspace settings in `.arashi/config.json`.

The personal managed-ignore preference is deliberately not stored in that shared file. In non-bare
worktrees, safe configured `reposDir` and `worktreesDir` paths default to repository-local Git
excludes. Bare repository roots instead report administrative subdirectories as non-applicable to
working-tree ignore rules and skip unsafe external paths such as the `..` worktree default. Select a
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
      "launch": "auto"
    },
    "editors": {
      "vscode": {
        "create": {
          "launch": "sesh"
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

- `switch` (boolean): independent post-create switch handling
- `launch` (`none` | `auto` | `sesh` | `herdr`): the single post-create launch choice

An absent `launch` preserves built-in no-launch behavior. `none` disables launch without disabling an independently enabled `switch`; `auto` uses context detection; and `sesh` or `herdr` select that launcher directly. Any enabled launch implies switch handling for the newly created primary worktree.

In a managed Kitty session, `auto` uses the same exact-marker, fail-closed launcher as `arashi switch`. A post-create Kitty failure returns a nonzero result but preserves the successfully created worktree and reports partial success. Resolve the Kitty error and run `arashi switch` rather than retrying creation for the same branch.

### `defaults.editors.<host>.create`

Supported hosts: `vscode`, `cursor`, `kiro`. These scopes use the same `switch` boolean and `launch` vocabulary. Use editor-scoped defaults when terminal `arashi create` should behave one way but an extension-driven create should behave differently.

Example:

```json
{
  "defaults": {
    "create": {
      "switch": true,
      "launch": "none"
    },
    "editors": {
      "vscode": {
        "create": {
          "launch": "sesh"
        }
      }
    }
  }
}
```

In that configuration, terminal `arashi create` uses `defaults.create`, while VS Code extension `create` uses `defaults.editors.vscode.create`. If an editor-hosted create invocation has no matching host override, Arashi applies no post-create defaults unless the user passes explicit CLI flags.

### `defaults.switch`

- `mode` (`auto` | `cd` | `launch` | `sesh` | `herdr`): the single switch behavior and launcher choice

Use `launch` for automatic launcher selection without preferring parent-shell switching, `cd` to request parent-shell switching, `sesh` or `herdr` to force that launcher, and `auto` for contextual selection. Contextual `auto` checks strict managed contexts in the order tmux → Herdr → cmux → integrated IDE → managed Kitty. Managed Kitty requires both local Kitty markers plus Kitty 0.43 or newer with permitted remote control; once selected, setup, inspection, focus, locking, and launch failures fail closed rather than continuing to another launcher. When no managed context is detected, `auto` uses `cd` if shell integration is active; otherwise it continues through terminal and platform launch fallback.

When `defaults.switch.mode` is absent, Arashi preserves the built-in `launch` behavior. Existing configurations therefore do not newly prefer `cd` merely because shell integration is installed.

Herdr automatic detection requires `HERDR_ENV` to normalize exactly to `1`. Herdr requires a Git-resolvable non-bare main checkout and a reachable default Herdr server/socket.

Enable shell integration with:

```bash
arashi shell install
```

If you prefer manual setup, print shell-specific wrapper code with `arashi shell init <bash|zsh|fish>`.

## Legacy create configuration migration

Legacy create `launch` booleans and `launchMode` / `launch_mode` remain readable for a bounded compatibility window. `true` maps to `auto` unless a legacy launcher selects `sesh` or `herdr`; `false` without a launcher maps to `none`; and a launcher without a boolean maps to that launcher. Compatible canonical-plus-legacy values and equal aliases are accepted. Arashi emits one scope-qualified stderr warning with the exact canonical replacement and leaves the source file byte-for-byte unchanged.

A legacy `false` plus any launcher, conflicting aliases, conflicting canonical/legacy choices, invalid launch values, and non-boolean `switch` values are rejected before repository discovery or mutation. Choose the single canonical `launch` value that represents the intended behavior.

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

For `arashi create`, reject `--sesh` plus `--herdr` first. Otherwise explicit `--sesh` / `--herdr` wins (and implies launch), followed by `--tab` / `--launch`, `--no-launch`, the matching configured scope, and built-in `none`. `--tab` bypasses the matching configured scope, implies launch and switch, and remains subordinate to an explicit launcher selector. `--switch` / `--no-switch` resolves independently when tab is absent, but launch implies switch. An editor-hosted create uses only its matching scope and does not fall back to terminal or another editor scope.

For `arashi switch`, the effective order is: Explicit launcher flags > `--cd` / `--no-cd` > configured mode > automatic context detection. Conflicting explicit launchers, or `--cd` combined with any explicit launcher, are rejected before switching.

For switch, `--tab` bypasses configured `sesh` or `herdr` launch defaults and uses automatic launcher resolution. An explicit launcher selector remains authoritative and composes with tab disposition.

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
