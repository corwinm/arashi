# Arashi

[![npm version](https://img.shields.io/npm/v/arashi.svg)](https://www.npmjs.com/package/arashi)
[![CI](https://github.com/corwinm/arashi/actions/workflows/ci.yml/badge.svg)](https://github.com/corwinm/arashi/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/corwinm/arashi.svg)](https://github.com/corwinm/arashi/blob/main/LICENSE)

Arashi is a Git worktree manager for meta-repositories. It helps keep related repositories aligned while you work on a feature branch across a workspace.

## Installation

```bash
npm install -g arashi
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
