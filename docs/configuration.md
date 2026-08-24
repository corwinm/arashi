# Configuration

Arashi stores workspace settings in `.arashi/config.json`.

For supported existing-workspace settings, run [`aw configure`](commands/configure.md). The command
keeps persisted state separate from effective runtime defaults and inheritance. Use direct JSON
editing for canonical fields outside its deliberately finite scope.

The personal managed-ignore preference is deliberately not stored in that shared file. In non-bare
worktrees, safe configured `reposDir` and `worktreesDir` paths default to repository-local Git
excludes. Bare repository roots instead report administrative subdirectories as non-applicable to
working-tree ignore rules and skip unsafe external paths such as the `..` worktree default. Select a
different clone-local policy with:

```bash
aw init --ignore-scope local    # default; remove any stored override
aw init --ignore-scope tracked  # maintain an owned block in .gitignore
aw init --ignore-scope none     # report only; manage ignore rules manually
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
  "baseBranch": "main",
  "meta": { "baseBranch": "develop" },
  "defaults": {
    "create": { "switch": true, "launch": "auto" },
    "editors": { "vscode": { "create": { "launch": "sesh" } } },
    "switch": { "mode": "sesh" }
  },
  "repos": {
    "api": {
      "path": "./repos/api",
      "gitUrl": "git@github.com:example/api.git",
      "baseBranch": "release/2.x"
    }
  }
}
```

## Deleting a configured repository

Use `aw delete <repository>` with an exact `repos` key, or run `aw delete` in a human TTY to
select multiple configured dependencies. Preview with `--dry-run` before confirming or using
`--force`; force accepts confirmation and disclosed Git data-loss risk, but structural and
concurrent-change checks still apply.

Deletion removes only the selected repository entry after its owned Git materialization and exact
repository-targeted workspace hooks are removed. Other repository entries, workspace defaults,
groups, shared hooks, and managed-ignore preferences/files remain unchanged, including when the
last configured dependency is deleted.

See [`aw delete`](./commands/delete.md) for the full safety and automation contract.

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

## Lifecycle hook timeout

All lifecycle hooks default to `300000` milliseconds (five minutes). To override the timeout for
configured create and remove hooks, set an integer from 1 through 2147483647:

```json
{
  "hooks": { "timeout": 300000 }
}
```

Zero, negative, fractional, non-numeric, and out-of-range values are rejected before hook discovery
or lifecycle mutation. See [the lifecycle hook contract](hooks.md) for timing, scope, environment,
rollback/finalization, native-platform discovery, and JSON outcome details.

## Inline lifecycle hook configuration

Configured workspaces may define a short, reviewable command inline instead of maintaining a native
hook file. Root `hooks.scripts.<lifecycle>` is the sole workspace-owned form, and
`repos.<name>.hooks.<lifecycle>` is the sole repository-owned form. `<lifecycle>` is exactly
`pre-create`, `post-create`, `pre-remove`, or `post-remove`; do not encode a repository name into a
key such as `pre-create.<repo>`.

A string value is Bash shorthand. For cross-platform configuration, use a non-empty interpreter map
whose only supported keys are `bash`, `powershell`, and `cmd`:

```json
{
  "hooks": {
    "timeout": 300000,
    "scripts": {
      "pre-create": "set -e; printf 'creating %s\\n' \"$ARASHI_BRANCH_NAME\"",
      "post-create": {
        "bash": "set -e; printf 'created %s\\n' \"$ARASHI_BRANCH_NAME\"",
        "powershell": "$ErrorActionPreference = 'Stop'; Write-Output \"created $env:ARASHI_BRANCH_NAME\"",
        "cmd": "echo created %ARASHI_BRANCH_NAME% || exit /b 1"
      },
      "pre-remove": "set -e; printf 'removing\\n'",
      "post-remove": "set -e; printf 'removed\\n'"
    }
  },
  "repos": {
    "api": {
      "gitUrl": "git@github.com:example/api.git",
      "hooks": {
        "pre-create": "set -e; printf 'api create\\n'",
        "post-create": "set -e; printf 'api ready\\n'",
        "pre-remove": "set -e; printf 'api remove\\n'",
        "post-remove": "set -e; printf 'api removed\\n'"
      }
    }
  }
}
```

Empty strings/maps, unsupported interpreter keys, and unknown lifecycle keys are rejected during
configuration validation. A snippet is non-portable unless every host that must run it has a
compatible variant. Prefer a native file for substantial scripts, reusable logic, or code that needs
normal review and testing. Do not put a secret in inline configuration: the config is shared and
versioned even though Arashi never discloses snippet text in logs, outcomes, previews, or doctor
findings.

## Worktree file materialization

Configured child repositories may declare direct `repos.<name>.copy` and `repos.<name>.symlink` arrays. Each portable repository-relative entry uses the same relative path from the canonical Git-primary checkout into a newly created coordinated worktree:

```json
{
  "repos": {
    "web": {
      "path": "repos/web",
      "copy": [".env.local"],
      "symlink": [".shared-cache"]
    }
  }
}
```

Repository construction runs `pre-create`, every `copy` entry in declaration order, every `symlink` entry in declaration order, and then `post-create`. `--no-hooks` does not disable materialization. Missing sources are visible non-fatal skips. Arashi never overwrites destinations, and paths must remain inside the canonical source checkout and new worktree. A rejected native symlink does not fall back to a copy, hard link, or junction.

Use `copy` for independent, isolated local configuration. Use `symlink` only for intentionally shared state. Prefer package-manager content-addressed stores and per-worktree installs over sharing `node_modules`, where branches, lockfiles, runtimes, native modules, and install scripts may diverge.

This behavior is configured-workspace-only; standalone create is not supported. Globs and remapping are not supported. Use lifecycle hooks for globs, remapping, external sources, interpolation, generated files, or conditional behavior. `aw create --dry-run` previews the ordered plan without mutation, and `aw doctor` inspects source availability and managed destination safety without repair.

## Repository base branches

Root `baseBranch` is the workspace fallback used by configured base-aware commands: `create`, `clone`,
`status`, `pull`, no-upstream `push` comparison, `handoff`, and `doctor`. `meta.baseBranch` overrides it
for the meta repository and `repos.<name>.baseBranch` overrides it for a named child repository.
Create and clone also accept a one-off `--base <branch>` and repeatable
`--repo-base <selector=branch>` overrides. Create accepts the explicit `@meta` selector, while clone
rejects it.

The shared persisted precedence is repository config → workspace config. For create and clone, the
full precedence is repository CLI → invocation CLI → repository config → workspace config. Arashi
normalizes one leading `origin/`, validates every selected repository, and resolves every effective
base before mutation. Standalone create accepts only invocation-level `--base`; standalone status,
handoff, and doctor retain their existing behavior without configured-base policy.

Status retains upstream and detected remote-default information while adding configured-base drift.
When base and default resolve to the same remote target, human output combines them and structured
output preserves both roles without duplicate refresh/comparison work. Pull fetches and merges the
configured remote base into the current branch; when no base is configured it retains current-upstream
behavior. Push destinations do not change: only a branch with no upstream uses configured base as its
publishability baseline. Handoff and doctor expose configured-base lag or unavailable states.

`defaults.create.baseBranch` is unsupported. Move a workspace-wide value to root `baseBranch`, or use
`meta.baseBranch` / `repos.<name>.baseBranch` for a repository-specific value. Configuration validation
rejects the removed property with migration guidance before repository discovery, hooks, network
access, or Git mutation.

## Command Defaults

You can set command-scoped defaults under `defaults`.

### `defaults.create`

- `switch` (boolean): independent post-create switch handling
- `launch` (`none` | `auto` | `sesh` | `herdr`): the single post-create launch choice

Editor-hosted create uses the same shared repository base policy; `baseBranch` is not valid in an
editor-scoped create object. Standalone create does not load or persist workspace defaults.

An absent `launch` preserves built-in no-launch behavior. `none` disables launch without disabling an independently enabled `switch`; `auto` uses context detection; and `sesh` or `herdr` select that launcher directly. Any enabled launch implies switch handling for the newly created primary worktree.

In a managed Kitty session, `auto` uses the same exact-marker, fail-closed launcher as `aw switch`. A post-create Kitty failure returns a nonzero result but preserves the successfully created worktree and reports partial success. Resolve the Kitty error and run `aw switch` rather than retrying creation for the same branch.

### `defaults.editors.<host>.create`

Supported hosts: `vscode`, `cursor`, `kiro`. These scopes use the same `switch` boolean and `launch` vocabulary. Use editor-scoped defaults when terminal `aw create` should behave one way but an extension-driven create should behave differently.

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

In that configuration, terminal `aw create` uses the generic launch and switch defaults, while VS Code extension `create` uses `defaults.editors.vscode.create` for launch and switch. Both use the shared root/meta/repository base policy. If an editor-hosted create invocation has no matching host override, Arashi applies no post-create launch or switch defaults unless the user passes explicit CLI flags.

### `defaults.switch`

- `mode` (`auto` | `cd` | `launch` | `sesh` | `herdr`): the single switch behavior and launcher choice

Use `launch` for automatic launcher selection without preferring parent-shell switching, `cd` to request parent-shell switching, `sesh` or `herdr` to force that launcher, and `auto` for contextual selection. Contextual `auto` checks strict managed contexts in the order tmux → Herdr → cmux → integrated IDE → managed Kitty. Managed Kitty requires both local Kitty markers plus Kitty 0.43 or newer with permitted remote control; once selected, setup, inspection, focus, locking, and launch failures fail closed rather than continuing to another launcher. When no managed context is detected, `auto` uses `cd` if shell integration is active; otherwise it continues through terminal and platform launch fallback.

When `defaults.switch.mode` is absent, Arashi preserves the built-in `launch` behavior. Existing configurations therefore do not newly prefer `cd` merely because shell integration is installed.

Herdr automatic detection requires `HERDR_ENV` to normalize exactly to `1`. Herdr requires a Git-resolvable non-bare main checkout and a reachable default Herdr server/socket.

Enable shell integration with:

```bash
aw shell install
```

If you prefer manual setup, print shell-specific wrapper code with `aw shell init <bash|zsh|fish>`.

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

The CLI spellings `--no-cd` and `--no-default-launch` remain accepted throughout Arashi 1.x as deprecated compatibility aliases for `--launch` and `--ignore-configured-launcher`, respectively. They are hidden from normal help, emit human-only migration warnings on stderr, and are not preferred usage. Their earliest removal is Arashi 2.0 and requires a separately approved breaking-change issue.

## Precedence Rules

For `aw create`, reject `--sesh` plus `--herdr` first. Otherwise explicit `--sesh` / `--herdr` wins (and implies launch), followed by `--tab` / `--launch`, `--no-launch`, the matching configured scope, and built-in `none`. `--tab` bypasses the matching configured scope, implies launch and switch, and remains subordinate to an explicit launcher selector. `--switch` / `--no-switch` resolves independently when tab is absent, but launch implies switch. An editor-hosted create uses only its matching scope and does not fall back to terminal or another editor scope.

For `aw switch`, the effective order is: Explicit launcher flags > `--cd` / `--launch` > configured mode > automatic context detection. Conflicting explicit launchers, or `--cd` combined with any launch intent, are rejected before switching.

For switch, `--tab` bypasses configured `sesh` or `herdr` launch defaults and uses automatic launcher resolution. An explicit launcher selector remains authoritative and composes with tab disposition.

`--tmux` is a per-invocation explicit launcher for both `switch` and `create`; it is not part of either persisted mode vocabulary. It requires `TMUX` to be non-empty after trimming and does not fall back when the prerequisite or tmux subprocess fails. For switch, `--tmux` conflicts with `--cd`, `--sesh`, `--herdr`, `--vscode`, `--cursor`, and `--kiro`; `--tmux` + `--launch` and `--tmux` + `--ignore-configured-launcher` remain valid because the explicit launcher wins. For create, `--tmux` conflicts with `--sesh` and `--herdr`, implies launch and switch, and overrides `--no-launch` and `--no-switch`. JSON mode rejects explicit tmux before conflict or context validation and before mutation.

Across command defaults generally, Arashi resolves values in this order:

1. Explicit CLI flag
2. Explicit opt-out flag
3. Configured default
4. Built-in default

Examples:

- `aw create feature-auth --launch` overrides config to force launch for that run.
- `aw create feature-auth --no-launch` disables configured create launch defaults for that run.
- Extension-driven `aw create` uses `defaults.editors.<host>.create` when present and otherwise skips post-create defaults.
- `aw switch feature-auth --cd` overrides config to request parent-shell directory switching for that run.
- `aw switch feature-auth --launch` forces launch behavior for that run even when switch defaults prefer `cd`, while preserving a configured launcher.
- `aw switch --ignore-configured-launcher` bypasses a configured `sesh` or `herdr` mode for that run; it does not erase configured `auto`, `cd`, or `launch` behavior.
- `aw switch --launch --ignore-configured-launcher` forces generic automatic launch.
