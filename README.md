# Arashi

[![npm version](https://img.shields.io/npm/v/arashi.svg)](https://www.npmjs.com/package/arashi)
[![CI](https://github.com/corwinm/arashi/actions/workflows/ci.yml/badge.svg)](https://github.com/corwinm/arashi/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/corwinm/arashi.svg)](https://github.com/corwinm/arashi/blob/main/LICENSE)

Arashi is a Git worktree manager for meta-repositories.

It keeps related repositories aligned while you work on a feature branch across a shared workspace.

[Documentation](https://arashi.haphazard.dev)

## Installation

### Option 1: Install with curl (official direct install)

Prerequisites:

- `curl`
- `bash`
- A SHA-256 tool (`shasum`, `sha256sum`, or `openssl`)

```bash
curl -fsSL https://arashi.haphazard.dev/install | bash
```

Install a specific release:

```bash
curl -fsSL https://arashi.haphazard.dev/install | ARASHI_VERSION=1.4.0 bash
```

Verify install:

```bash
arashi --version
```

By default, the installer places `arashi` in `~/.arashi/bin`, adds that path to your shell config, and in interactive installs offers to enable shell integration for `arashi switch --cd`.
It also runs a quick `arashi --version` smoke test before declaring success.

If curl installation fails, or if the smoke test reports a bad release artifact, use npm installation below or the manual release instructions in [`docs/INSTALLATION.md`](./docs/INSTALLATION.md).

### Option 2: Install on Windows with PowerShell

PowerShell is the canonical Windows installer:

```powershell
powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"
```

It verifies and installs `arashi.bin.exe`, the extensionless `arashi` wrapper for Git Bash, `arashi.ps1`, and `arashi.bat` from the same release. The default directory is `%USERPROFILE%\.arashi\bin`; the installer adds it to the persistent user PATH. It does not create or modify `.bashrc` or another shell profile. Open a new Git Bash window before running `arashi --version` so it inherits the PATH change.

### Option 3: Install with npm

```bash
npm install -g arashi
```

The npm package is script-free: it does not require package-manager lifecycle scripts or `postinstall` approval. It installs the lightweight JavaScript entrypoint and wrapper files first, then downloads the matching platform binary on first use.

To preinstall the binary explicitly, run:

```bash
arashi install
```

To check for package updates or refresh the matching platform binary, run:

```bash
arashi update --check
arashi update --dry-run
arashi update --yes
```

`arashi update` can update npm-managed installs when it can confidently detect the package manager, including npm, pnpm, Yarn, Bun, and Vite+ (`vp update -g arashi`). For official direct-installer installs, `arashi update --yes` reruns the platform installer against the current binary directory: the POSIX curl installer on macOS/Linux and a deferred PowerShell installer on Windows after the current Arashi process exits.

Verify install:

```bash
arashi --version
```

If npm is unavailable or binary installation fails, use the curl installer command above or the manual release instructions in [`docs/INSTALLATION.md`](./docs/INSTALLATION.md).

### Manual install from GitHub Releases

If you prefer not to use npm, download a platform binary from [GitHub Releases](https://github.com/corwinm/arashi/releases) and place it on your `PATH`.

macOS (Apple Silicon):

```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-macos-arm64 -o arashi
chmod +x arashi
sudo mv arashi /usr/local/bin/arashi
```

Linux (x64):

```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-linux-x64 -o arashi
chmod +x arashi
sudo mv arashi /usr/local/bin/arashi
```

Windows (PowerShell and Git Bash):

```powershell
# Download arashi-windows-x64.exe, arashi, arashi.ps1, arashi.bat,
# and arashi-checksums.txt from the same release.
# Verify all four payload files against arashi-checksums.txt.
# Rename arashi-windows-x64.exe to arashi.bin.exe and keep the four files together on PATH.
```

Windows manual installation requires `arashi-windows-x64.exe`, `arashi`, `arashi.ps1`, `arashi.bat`, and `arashi-checksums.txt` from the same release. Verify all four payload files, rename the executable to `arashi.bin.exe`, and keep the payload together on PATH.

You can also build from source for local development:

```bash
pnpm install
pnpm run build
```

## Command Surface

Arashi currently provides these commands:

- `arashi init`
- [`arashi init --zero-config`](docs/standalone.md) for a single repository with `.worktrees/<branch>` paths and no persisted Arashi configuration
- `arashi install`
- `arashi update [--check] [--dry-run] [--yes]`
- `arashi add <git-url>`
- `arashi clone [--all]`
- `arashi create <branch> [--tmux|--sesh|--herdr]`
- `arashi list`
- `arashi status`
- `arashi remove <branch|path>`
- `arashi prune [--dry-run]` - clean stale Git worktree metadata
- `arashi switch [filter] [--repos|--all] [--cd|--no-cd] [--tmux|--sesh|--herdr] [--no-default-launch]`
- `arashi shell init <bash|zsh|fish>`
- `arashi shell install`
- `arashi pull`
- `arashi push [--set-upstream] [--dry-run] [--only <repo>] [--json]`
- `arashi sync`
- `arashi setup [--only <repo>] [--verbose]`

## Quick Example

```bash
arashi init                         # repository-local ignore rules (default)
arashi init --ignore-scope tracked  # opt in to a shared .gitignore block
arashi add git@github.com:your-org/frontend.git
arashi add git@github.com:your-org/backend.git
arashi create feature-auth-refresh
arashi create feature-auth-refresh --launch
arashi create feature-auth-refresh --tmux
arashi create feature-auth-refresh --herdr
arashi create feature-auth-refresh --no-launch
arashi shell install
arashi status
arashi switch feature-auth-refresh          # parent repo worktrees
arashi switch --repos feature-auth-refresh  # child repo worktrees in current workspace
arashi switch --all feature-auth-refresh    # all repos
arashi switch --repos docs                  # repo-name matching in child repos
arashi switch --cd feature-auth-refresh     # parent-shell cd when shell integration is active
arashi switch --tmux feature-auth-refresh   # force a new plain tmux window
arashi switch --herdr feature-auth-refresh  # open or focus a persistent Herdr workspace
arashi switch --no-default-launch           # bypass configured sesh/Herdr mode once
```

Explicit `--tmux` is a per-invocation launcher override for `create` and `switch`; it is not a persisted configuration mode. It requires an active tmux context whose `TMUX` value is non-empty after trimming, uses the selected worktree path as one argv-safe `tmux new-window -c` argument, and does not fall back to another launcher when the prerequisite or launch fails. On `create`, it implies both launch and switch, while validation failures occur before worktree mutation.

### Managed Git ignore rules

Configured workspaces keep `reposDir` and `worktreesDir` effectively ignored. Arashi asks Git
first, so an existing tracked `.gitignore`, repository-local `.git/info/exclude`, or configured
global excludes rule is honored without duplication. Missing safe repository-relative rules use
the common repository's local exclude file by default, including when a command runs in a linked
worktree.

Use `arashi init --ignore-scope tracked` when the team wants Arashi-owned rules committed in the
workspace `.gitignore`. Use `arashi init --ignore-scope none` for a fully manual workflow; Arashi
will warn about unignored managed paths but will not edit ignore files. Running
`arashi init --ignore-scope local` resets that clone-local preference without recreating an
existing workspace. The explicit `tracked` or `none` preference is stored only in local Git config
as `arashi.ignoreScope`; Arashi never creates or modifies global Git ignore configuration.

`init`, `pull`, `clone`, `add`, and `create` reconcile the same owned rules before materializing
configured repositories or worktrees. `doctor` reports missing, unsafe, invalid, or stale managed
ignore state without changing it.

## Workflow Guides

Use the docs site workflow guides when you want setup guidance by outcome instead of by individual command.

For contributors working on Arashi itself, the project planning workflow in the `arashi-arashi` meta-repo now uses OpenSpec. Older SpecKit-oriented references in legacy planning artifacts are historical context only.

- Hooks and configuration defaults: [arashi.haphazard.dev/workflows/hooks-and-config](https://arashi.haphazard.dev/workflows/hooks-and-config/)
- Integrations for Herdr, VSCode, tmux, and `tmux` plus `sesh`: [arashi.haphazard.dev/workflows](https://arashi.haphazard.dev/workflows/)
- Agent-assisted and spec-driven change flow: [arashi.haphazard.dev/workflows/agents-and-specs](https://arashi.haphazard.dev/workflows/agents-and-specs/)

## Shell Integration

Use shell integration when you want `arashi switch` to change the current shell directory instead of only opening a new terminal or editor context.

The official curl installer can offer this automatically. If you skip it or use npm, install it for the active shell with:

```bash
arashi shell install
```

Or print wrapper code for manual setup:

```bash
arashi shell init bash
arashi shell init zsh
arashi shell init fish
```

Once installed, you can use `arashi switch --cd <filter>` for one-off parent-shell switching or set `.arashi/config.json` `defaults.switch.mode` to `"cd"` or contextual `"auto"`. The canonical modes are `auto` | `cd` | `launch` | `sesh` | `herdr`.

If shell integration is inactive, `arashi switch --cd` warns and skips launch fallback for that invocation.

For automated installs, set `ARASHI_SHELL_INTEGRATION=yes` to enable it without prompting or `ARASHI_SHELL_INTEGRATION=no` to skip it.

## Hooks

Arashi can run lifecycle hooks during `arashi create` and `arashi remove`.

- Global hooks in `.arashi/hooks/`:
  - `pre-create.sh`
  - `post-create.sh`
  - `pre-remove.sh`
  - `post-remove.sh`
- Repository-specific hooks:
  - `pre-create.<repo>.sh`
  - `post-create.<repo>.sh`
- Scoped remove hooks:
  - repository scope: `repos/<repo>/.arashi/hooks/pre-remove.sh` and `post-remove.sh`
  - global shared: `~/.arashi/hooks/pre-remove.sh` and `post-remove.sh`
  - global targeted: `~/.arashi/hooks/<repo>/pre-remove.sh` and `post-remove.sh`

For `arashi remove`, hook execution order is: repository scope -> workspace-root scope -> global targeted scope -> global shared scope.

`pre-remove.sh` is useful for teardown before deletion (for example, stopping tmux sessions), and `post-remove.sh` can run final cleanup after remove operations complete.

See [`docs/hooks.md`](./docs/hooks.md) for hook behavior, environment variables, and examples.

## Workflow Shortcuts

Use `arashi list` with `fzf` and optional keybinds to speed up daily navigation.

### Jump to a worktree (`cd`)

```bash
# One-off jump
cd "$(arashi list | fzf)"
```

```bash
# Bash keybind (Ctrl+G)
bind '"\C-g":"cd \$(arashi list | fzf)\n"'
```

```zsh
# Zsh keybind (Ctrl+G)
bindkey -s '^g' 'cd $(arashi list | fzf)\n'
```

### Open or switch tmux sessions with `sesh`

```bash
# One-off session connect
sesh connect "$(arashi list | fzf)"
```

```bash
# Bash keybind (Ctrl+S)
bind '"\C-s":"sesh connect \$(arashi list | fzf)\n"'
```

```zsh
# Zsh keybind (Ctrl+S)
bindkey -s '^s' 'sesh connect $(arashi list | fzf)\n'
```

You can also use `arashi switch --sesh` directly inside tmux to open the selected worktree in a new tmux window.

`arashi switch` checks managed contexts in this order: tmux → Herdr → cmux → integrated IDE → Kitty. Managed Kitty selection requires both `KITTY_PID` and `KITTY_WINDOW_ID`; `TERM=xterm-kitty` alone remains only generic terminal evidence.

Managed Kitty requires Kitty 0.43 or newer plus working `kitten @` remote control. Arashi reuses only its exact worktree marker and focuses that tab before launching a new session-backed tab. Once managed Kitty is selected, missing or unsupported tooling, denied remote control, duplicate markers, and validation failures are reported directly instead of falling back to another launcher.

`arashi create --launch` and `defaults.create.launch: "auto"` use the same managed Kitty behavior. If that post-create launch fails, Arashi exits nonzero but preserves the successfully created worktree and reports the launch as partial success. Fix the launcher problem and use `arashi switch`; do not retry creation for the same branch.

### Fast remove selection

```bash
# Select and remove a worktree quickly
arashi remove -f "$(arashi list | fzf)"
```

If you prefer the term `delete`, create a shell alias:

```bash
alias arashi-delete='arashi remove -f'
```

## Configuration Schema

Arashi publishes a JSON Schema for `.arashi/config.json` so editors can validate and autocomplete your config.

- Stable URL: `https://unpkg.com/arashi/schema/config.schema.json`
- Version-pinned URL: `https://unpkg.com/arashi@1.7.0/schema/config.schema.json`

Example config header:

```json
{
  "$schema": "https://unpkg.com/arashi/schema/config.schema.json",
  "version": "1.0.0",
  "reposDir": "./repos",
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
    },
    "switch": {
      "mode": "sesh"
    }
  },
  "repos": {}
}
```

`defaults.switch.mode` accepts `auto` | `cd` | `launch` | `sesh` | `herdr`. Contextual `auto` checks strict managed contexts in the order tmux → Herdr → cmux → integrated IDE → managed Kitty, then uses parent-shell `cd` when shell integration is active, and otherwise follows terminal/platform launch fallback. An absent mode preserves the built-in automatic `launch` behavior rather than newly preferring `cd`.

Explicit launcher flags take precedence over `--cd` / `--no-cd`, which take precedence over the configured mode and automatic context detection. `--no-default-launch` bypasses only configured `sesh` or `herdr`. `--herdr` remains available on both `create` and `switch`; Herdr launch uses `herdr worktree open` with the Git-resolved non-bare main checkout and selected worktree.

Legacy switch-only `launchMode` and `launch_mode` fields remain readable for a bounded compatibility window. Arashi warns with the exact replacement `defaults.switch.mode` on stderr; migrate promptly. Ambiguous `cd` plus an explicit legacy launcher and conflicting legacy aliases are rejected.

Use `defaults.create` for terminal `arashi create` behavior. Use `defaults.editors.<host>.create` for editor-specific overrides such as VS Code extension create flows. Supported hosts are `vscode`, `cursor`, and `kiro`. Each scope has one canonical `launch` choice: `none` | `auto` | `sesh` | `herdr`. `switch` stays independent, while any enabled launch implies switch handling for the newly created primary worktree.

Create precedence is: reject `--sesh` plus `--herdr`; then explicit `--sesh` / `--herdr`; `--launch`; `--no-launch`; the matching configured scope; and built-in `none`. An editor-hosted invocation does not fall back to terminal or another editor scope.

Legacy create booleans plus `launchMode` / `launch_mode` remain readable for a bounded compatibility window. Accepted combinations warn on stderr with the exact canonical replacement and do not rewrite the file. Disabled launch plus a launcher, conflicting aliases, and conflicting canonical/legacy choices are rejected before workspace mutation.

Defaults precedence for unrelated switch behavior remains unchanged.

## skills.sh Integration

Arashi also ships a dedicated `skills.sh` integration package for guided installation, workflow examples, and troubleshooting.

- Skill repository: [`repos/arashi-skills`](../arashi-skills/README.md)
- Canonical skill manifest: [`repos/arashi-skills/skills/arashi/SKILL.md`](../arashi-skills/skills/arashi/SKILL.md)
- Workflow catalog: [`repos/arashi-skills/skills/arashi/references/workflows.md`](../arashi-skills/skills/arashi/references/workflows.md)
- Session shortcuts: [`repos/arashi-skills/skills/arashi/references/session-shortcuts.md`](../arashi-skills/skills/arashi/references/session-shortcuts.md)

## Documentation

- Installation details: [`docs/INSTALLATION.md`](./docs/INSTALLATION.md)
- Configuration details: [`docs/configuration.md`](./docs/configuration.md)
- Clone command details: [`docs/commands/clone.md`](./docs/commands/clone.md)
- Hook behavior: [`docs/hooks.md`](./docs/hooks.md)
- Workflow guides: [https://arashi.haphazard.dev/workflows/](https://arashi.haphazard.dev/workflows/)
- Shell integration details: [`docs/commands/shell.md`](./docs/commands/shell.md)
- Setup command details: [`docs/commands/setup.md`](./docs/commands/setup.md)
- Switch command details: [`docs/commands/switch.md`](./docs/commands/switch.md)
- Remove command details: [`docs/commands/remove.md`](./docs/commands/remove.md)
- Push command details: [`docs/commands/push.md`](./docs/commands/push.md)
- FZF integration: [`docs/FZF_COMPATIBILITY.md`](./docs/FZF_COMPATIBILITY.md)

## Contributing

Use the canonical guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

For specs and planning workflow, see the specs repository: [github.com/corwinm/arashi-arashi](https://github.com/corwinm/arashi-arashi).

## License

MIT
