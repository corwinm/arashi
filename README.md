# Arashi

> 嵐 - The eye of the storm for your development workflow

Arashi is a Git worktree manager for meta-repositories that automatically manages worktrees across multiple related repositories. When working on features that span multiple repositories, Arashi simplifies the workflow by ensuring all related repositories maintain synchronized worktrees.

## Status

🚧 **Under Active Development** - Phase 1 Complete

This project is currently in early development. See [DESIGN.md](./DESIGN.md) for the complete feature roadmap and implementation plan.

## Vision

Arashi will enable developers to:
- Create coordinated worktrees across multiple repositories with a single command
- Automatically manage branch synchronization across related repos
- Simplify setup and teardown of development environments
- Maintain clean git state across meta-repository structures

## Quick Start (Coming Soon)

```bash
# Initialize arashi in your meta-repository
arashi init

# Add repositories to manage
arashi add git@github.com:user/frontend.git
arashi add git@github.com:user/backend.git

# Create a new feature worktree across all repos
arashi create feature-new-api

# Check status across all repos
arashi status

# Remove worktree when done
arashi remove feature-new-api
```

## Planned Commands

- `arashi init` - Initialize arashi in current repository
- `arashi add <git-url>` - Add a repository to the repos folder
- `arashi create <branch>` - Create coordinated worktrees
- `arashi list` - List all worktrees
- `arashi remove <branch>` - Remove worktrees and branches
- `arashi setup` - Run setup scripts
- `arashi status` - Show status of all repositories

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Build single-file executable
bun run build

# Run tests (coming soon)
bun test
```

## Architecture

Arashi is built with:
- **Runtime:** Bun (single-file executable)
- **Language:** TypeScript
- **CLI Framework:** Commander.js
- **User Prompts:** @inquirer/prompts

## Documentation

- [Design Document](./DESIGN.md) - Complete feature roadmap and technical design
- [Contributing Guide](./DESIGN.md#contributing) - How to contribute to Arashi

## Roadmap

See [DESIGN.md](./DESIGN.md) for the complete feature roadmap organized by implementation phases.

### Current Phase: Foundation (Phase 1)
- [x] Project setup and structure
- [x] Type definitions
- [ ] Utility libraries (git, config, filesystem, logger, prompts)

### Next Phase: Core Commands (Phase 2)
- [ ] `init` command
- [ ] `add` command
- [ ] `create` command

## Why "Arashi"?

嵐 (Arashi) means "storm" in Japanese. This tool aims to be the calm center - the eye of the storm - that brings order to the chaos of managing multiple repositories and worktrees.

## License

MIT

---

**Note:** This project is under active development. Features and APIs may change.
