# Arashi

[![npm version](https://img.shields.io/npm/v/arashi.svg)](https://www.npmjs.com/package/arashi)
[![CI](https://github.com/corwinm/arashi/actions/workflows/ci.yml/badge.svg)](https://github.com/corwinm/arashi/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/corwinm/arashi.svg)](https://github.com/corwinm/arashi/blob/main/LICENSE)

Arashi is a Git worktree manager for meta-repositories. It coordinates related repositories in one feature workspace while each repository keeps its own history, CI, and pull requests.

[Documentation](https://arashi.haphazard.dev) · [Command reference](https://arashi.haphazard.dev/commands/) · [Workflow guides](https://arashi.haphazard.dev/workflows/)

## Installation

macOS and Linux:

```bash
curl -fsSL https://arashi.haphazard.dev/install | bash
```

Windows PowerShell:

```powershell
powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"
```

Open a new terminal after the Windows installer so it inherits the updated user `PATH`.

With npm:

```bash
npm install -g arashi
```

Verify the installation:

```bash
aw --version
```

`aw` is the preferred command name. `arashi` remains available for existing scripts and workflows. See the [installation guide](./docs/INSTALLATION.md) for version pinning, manual installation, and troubleshooting, or the [`update` command guide](https://arashi.haphazard.dev/commands/update/) for upgrades.

## Quick start

From the repository that will coordinate your projects:

```bash
aw init
aw add git@github.com:your-org/frontend.git
aw add git@github.com:your-org/backend.git
aw create feature-auth-refresh
```

Arashi creates matching worktrees for the configured repositories. From there, use:

```bash
aw status                         # inspect the coordinated workspace
aw switch feature-auth-refresh    # return to a worktree
aw pull                           # update repositories
aw push --set-upstream            # publish branches
aw remove feature-auth-refresh    # remove the coordinated worktrees
aw delete backend --dry-run       # preview deleting a configured dependency
```

For a single repository without persisted Arashi configuration, use `aw init --zero-config`. See the [standalone workflow](https://arashi.haphazard.dev/workflows/standalone/).

## Core commands

| Command                           | Purpose                                   |
| --------------------------------- | ----------------------------------------- |
| `aw init`                         | Initialize a workspace                    |
| `aw add`                          | Add a repository                          |
| `aw delete`                       | Delete configured repository dependencies |
| `aw clone`                        | Clone configured repositories             |
| `aw configure`                    | Edit existing workspace settings          |
| `aw create`                       | Create coordinated worktrees              |
| `aw list`                         | List worktrees                            |
| `aw status`                       | Show repository status                    |
| `aw switch`                       | Select and open a worktree                |
| `aw pull` / `aw push` / `aw sync` | Synchronize repositories                  |
| `aw setup`                        | Run repository setup steps                |
| `aw remove` / `aw prune`          | Clean up branch worktrees and metadata    |
| `aw doctor`                       | Diagnose workspace problems               |
| `aw update`                       | Update Arashi                             |

Run `aw --help`, `aw <command> --help`, or use the [complete command reference](https://arashi.haphazard.dev/commands/) for options and examples.

## Shell integration

Install shell integration for parent-shell directory switching and completion in Bash, Zsh, or Fish:

```bash
aw shell install
```

You can then use `aw switch --cd <filter>` to change the current shell's directory. See the [shell command guide](https://arashi.haphazard.dev/commands/shell/) for manual setup.

## More documentation

- [Getting started](https://arashi.haphazard.dev/getting-started/)
- [Configuration](https://arashi.haphazard.dev/workflows/config/)
- [Hooks](https://arashi.haphazard.dev/workflows/hooks/)
- [Editor and terminal integrations](https://arashi.haphazard.dev/workflows/)
- [JSON automation](https://arashi.haphazard.dev/workflows/json-automation/)
- [Local configuration reference](./docs/configuration.md)

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Planning and specifications live in [corwinm/arashi-arashi](https://github.com/corwinm/arashi-arashi).

## License

MIT
