# Arashi

> 嵐 - The eye of the storm for your development workflow

Arashi is a Git worktree manager for meta-repositories that automatically manages worktrees across multiple related repositories. When working on features that span multiple repositories, Arashi simplifies the workflow by ensuring all related repositories maintain synchronized worktrees.

## Documentation

📋 **For complete design documents, specifications, and planning, see the [Arashi Specifications Repository](https://github.com/corwinm/arashi-arashi).**

## Status

🚧 **Under Active Development** - Phase 1 Complete

This project is currently in early development. See the [Design Document](https://github.com/corwinm/arashi-arashi/tree/main/setup/.specify/memory/design.md) in the specs repository for the complete feature roadmap and implementation plan.

## Installation (Coming Soon)

### npm (Recommended)

```bash
npm install -g arashi
```

### Direct Binary Download

Download the latest release for your platform from [GitHub Releases](https://github.com/corwinm/arashi/releases):

**macOS (Apple Silicon)**
```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-macos-arm64 -o arashi
chmod +x arashi
sudo mv arashi /usr/local/bin/
```

**Linux (x64)**
```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-linux-x64 -o arashi
chmod +x arashi
sudo mv arashi /usr/local/bin/
```

**Windows (x64)**
- Download `arashi-windows-x64.exe` from [GitHub Releases](https://github.com/corwinm/arashi/releases)
- Add to your PATH

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

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3.0 (for development)
- Node.js >= 18.0.0 (for npm installation)

### Setup

```bash
# Clone the repository
git clone https://github.com/corwinm/arashi.git
cd arashi

# Install dependencies
bun install

# Run in development mode
bun run dev

# Build single-file executable
bun run build

# Build for all platforms
bun run build:all

# Run tests (coming soon)
bun test

# Type check
bun run lint
```

### Contributing

We welcome contributions! Please see our [Specifications Repository](https://github.com/corwinm/arashi-arashi) for:
- [Design Document](https://github.com/corwinm/arashi-arashi/tree/main/setup/.specify/memory/design.md) - Feature roadmap and technical design
- [Contributing Guide](https://github.com/corwinm/arashi-arashi/blob/main/setup/CONTRIBUTING.md) - Specs-first development workflow

**Quick Summary:**
1. Specs are created in the [arashi-arashi repository](https://github.com/corwinm/arashi-arashi) first
2. Implementation happens in this repository
3. Use conventional commits
4. All PRs require review
5. Squash merge with conventional commit message

**Commit Message Format:**
We use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add interactive mode for repo selection
fix: handle worktrees with uncommitted changes
docs: update installation instructions
```

## Architecture

Arashi is built with:
- **Runtime:** Bun (single-file executable)
- **Language:** TypeScript
- **CLI Framework:** Commander.js
- **User Prompts:** @inquirer/prompts

## Roadmap

See the [Design Document](https://github.com/corwinm/arashi-arashi/tree/main/setup/.specify/memory/design.md) in the specs repository for the complete feature roadmap organized by implementation phases.

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
