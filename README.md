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

By default, the installer places `arashi` in `~/.arashi/bin` and adds that path to your shell config.

If curl installation fails, use npm installation below or the manual release instructions in [`docs/INSTALLATION.md`](./docs/INSTALLATION.md).

### Option 2: Install with npm

```bash
npm install -g arashi
```

Verify install:

```bash
arashi --version
```

If npm is unavailable or fails, use the curl installer command above or the manual release instructions in [`docs/INSTALLATION.md`](./docs/INSTALLATION.md).

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

Windows (PowerShell):

```powershell
Invoke-WebRequest -Uri "https://github.com/corwinm/arashi/releases/latest/download/arashi-windows-x64.exe" -OutFile "arashi.exe"
# Move arashi.exe to a folder on your PATH
```

You can also build from source for local development:

```bash
bun install
bun run build
```

## Command Surface

Arashi currently provides these commands:

- `arashi init`
- `arashi add <git-url>`
- `arashi clone [--all]`
- `arashi create <branch>`
- `arashi list`
- `arashi status`
- `arashi remove <branch|path>`
- `arashi switch [filter] [--repos|--all] [--sesh] [--no-default-launch]`
- `arashi pull`
- `arashi sync`
- `arashi setup [--only <repo>] [--verbose]`

## Quick Example

```bash
arashi init
arashi add git@github.com:your-org/frontend.git
arashi add git@github.com:your-org/backend.git
arashi create feature-auth-refresh
arashi create feature-auth-refresh --launch
arashi create feature-auth-refresh --no-launch
arashi status
arashi switch feature-auth-refresh          # parent repo worktrees
arashi switch --repos feature-auth-refresh  # child repo worktrees in current workspace
arashi switch --all feature-auth-refresh    # all repos
arashi switch --repos docs                  # repo-name matching in child repos
arashi switch --no-default-launch           # bypass configured launch mode defaults once
```

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

`arashi switch` also detects tmux, Kitty, Ghostty, WezTerm, and iTerm2 contexts and prefers terminal-native launch behavior when available.

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

Defaults precedence for create/switch behavior: explicit CLI flag > opt-out flag > config default > built-in default.

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
- Setup command details: [`docs/commands/setup.md`](./docs/commands/setup.md)
- Switch command details: [`docs/commands/switch.md`](./docs/commands/switch.md)
- Remove command details: [`docs/commands/remove.md`](./docs/commands/remove.md)
- FZF integration: [`docs/FZF_COMPATIBILITY.md`](./docs/FZF_COMPATIBILITY.md)

## Contributing

Use the canonical guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

For specs and planning workflow, see the specs repository: [github.com/corwinm/arashi-arashi](https://github.com/corwinm/arashi-arashi).

## License

MIT
