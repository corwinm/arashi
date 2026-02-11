# Arashi

[![npm version](https://img.shields.io/npm/v/arashi.svg)](https://www.npmjs.com/package/arashi)
[![CI](https://github.com/corwinm/arashi/actions/workflows/ci.yml/badge.svg)](https://github.com/corwinm/arashi/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/corwinm/arashi.svg)](https://github.com/corwinm/arashi/blob/main/LICENSE)

Arashi is a Git worktree manager for meta-repositories.

It keeps related repositories aligned while you work on a feature branch across a shared workspace.

[Documentation](https://arashi.haphazard.dev)

## Installation

```bash
npm install -g arashi
```

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
- `arashi create <branch>`
- `arashi list`
- `arashi status`
- `arashi remove <branch|path>`
- `arashi pull`
- `arashi sync`
- `arashi setup [--only <repo>] [--verbose]`

## Quick Example

```bash
arashi init
arashi add git@github.com:your-org/frontend.git
arashi add git@github.com:your-org/backend.git
arashi create feature-auth-refresh
arashi status
```

## Hooks

Arashi can run lifecycle hooks during `arashi create` to automate setup steps.

- Global hooks in `.arashi/hooks/`:
  - `pre-create.sh`
  - `post-create.sh`
- Repository-specific hooks:
  - `pre-create.<repo>.sh`
  - `post-create.<repo>.sh`

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

### Fast remove selection

```bash
# Select and remove a worktree quickly
arashi remove -f "$(arashi list | fzf)"
```

If you prefer the term `delete`, create a shell alias:

```bash
alias arashi-delete='arashi remove -f'
```

## skills.sh Integration

Arashi also ships a dedicated `skills.sh` integration package for guided installation, workflow examples, and troubleshooting.

- Skill repository: [`repos/arashi-skills`](../arashi-skills/README.md)
- Canonical skill manifest: [`repos/arashi-skills/skills/arashi/SKILL.md`](../arashi-skills/skills/arashi/SKILL.md)
- Workflow catalog: [`repos/arashi-skills/skills/arashi/references/workflows.md`](../arashi-skills/skills/arashi/references/workflows.md)
- Session shortcuts: [`repos/arashi-skills/skills/arashi/references/session-shortcuts.md`](../arashi-skills/skills/arashi/references/session-shortcuts.md)

## Documentation

- Installation details: [`docs/INSTALLATION.md`](./docs/INSTALLATION.md)
- Hook behavior: [`docs/hooks.md`](./docs/hooks.md)
- Setup command details: [`docs/commands/setup.md`](./docs/commands/setup.md)
- Remove command details: [`docs/commands/remove.md`](./docs/commands/remove.md)
- FZF integration: [`docs/FZF_COMPATIBILITY.md`](./docs/FZF_COMPATIBILITY.md)

## Contributing

Use the canonical guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

For specs and planning workflow, see the specs repository: [github.com/corwinm/arashi-arashi](https://github.com/corwinm/arashi-arashi).

## License

MIT
