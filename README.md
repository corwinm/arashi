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

The npm package includes everything you need for full fzf compatibility.

### Direct Binary Download

Download and extract the latest release for your platform from [GitHub Releases](https://github.com/corwinm/arashi/releases):

**macOS (Apple Silicon)**

```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-macos-arm64.tar.gz -o arashi.tar.gz
tar xzf arashi.tar.gz
cd arashi-macos-arm64
sudo cp arashi arashi.bin /usr/local/bin/
```

**Linux (x64)**

```bash
curl -L https://github.com/corwinm/arashi/releases/latest/download/arashi-linux-x64.tar.gz -o arashi.tar.gz
tar xzf arashi.tar.gz
cd arashi-linux-x64
sudo cp arashi arashi.bin /usr/local/bin/
```

**Windows (x64)**

- Windows support coming soon (wrapper script needs PowerShell equivalent)

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

# Preview worktrees without creating them
arashi create --dry-run feature-new-api

# Check status across all repos
arashi status

# Sync repos to the parent branch
arashi sync

# Remove worktree when done
arashi remove feature-new-api

# Remove a specific worktree path
arashi remove -f "$(arashi list | fzf)"
```

Note: `arashi remove` requires an interactive TTY. In non-interactive runs it exits with a clear error.

## Hooks

Arashi can run lifecycle hooks during `arashi create` to automate setup tasks.

- Global hooks in `.arashi/hooks/`:
  - `pre-create.sh`
  - `post-create.sh`
- Repo-specific hooks in `.arashi/hooks/`:
  - `pre-create.<child-repo>.sh`
  - `post-create.<child-repo>.sh`

Repo-specific hooks run in the new child worktree context and receive main/parent repo paths via environment variables.

See `docs/hooks.md` for details.

## Commands

- `arashi init` - Initialize arashi in current repository
- `arashi add <git-url>` - Add a repository to the repos folder
- `arashi create <branch>` - Create coordinated worktrees
- `arashi list` - List all worktrees
- `arashi remove <branch|path>` - Remove worktrees and branches
- `arashi setup [--only <repo>] [--verbose]` - Run setup scripts across workspace repositories
- `arashi status` - Show status of all repositories
- `arashi sync` - Align repositories to the parent branch

## Integration with fzf, tmux, and sesh

The `arashi list` command outputs clean, full paths perfect for piping to tools like fzf. Here are powerful workflow integrations:

### Basic: Change Directory with fzf

Navigate to any worktree interactively:

```bash
# Interactive worktree selection
cd $(arashi list | fzf)

# Remove a selected worktree
arashi remove -f "$(arashi list | fzf)"
```

**Add as a shell keybinding** for instant access:

#### Bash/Zsh

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
# Ctrl+G to select and navigate to worktree
bind '"\C-g":"cd \$(arashi list | fzf)\n"'  # Bash
bindkey -s '^g' 'cd $(arashi list | fzf)\n'  # Zsh
```

Press `Ctrl+G` from anywhere to fuzzy-find and jump to a worktree.

#### Fish

Add to your `~/.config/fish/config.fish`:

```fish
# Ctrl+G to select and navigate to worktree
function __arashi_worktree_jump
    set -l worktree (arashi list | fzf)
    and cd $worktree
    commandline -f repaint
end
bind \cg __arashi_worktree_jump
```

### Advanced: tmux Session Management

Create or switch to a tmux session for a worktree:

```bash
# Function to create/attach tmux session for worktree
arashi-tmux() {
  local worktree=$(arashi list | fzf)
  if [ -n "$worktree" ]; then
    # Create session name from last path component
    local session_name=$(basename "$worktree")

    # Create session if it doesn't exist
    if ! tmux has-session -t "$session_name" 2>/dev/null; then
      tmux new-session -d -s "$session_name" -c "$worktree"
    fi

    # Switch to or attach session
    if [ -n "$TMUX" ]; then
      tmux switch-client -t "$session_name"
    else
      tmux attach-session -t "$session_name"
    fi
  fi
}

# Bind to Ctrl+G
bind '"\C-g":"arashi-tmux\n"'  # Bash
bindkey -s '^g' 'arashi-tmux\n'  # Zsh
```

**What this does:**

1. Fuzzy-find a worktree with fzf
2. Create a named tmux session for that worktree (if needed)
3. Switch to the session, preserving your current context

### Simplified: Using sesh

[sesh](https://github.com/joshmedeski/sesh) is a smart session manager for tmux. Integrate arashi with sesh for the ultimate workflow:

#### Setup

Follow sesh's [installation instructions](https://github.com/joshmedeski/sesh?tab=readme-ov-file#how-to-install)

#### Usage

```bash
# Select from arashi worktrees
sesh connect $(arashi list | fzf)

# Or create a keybinding (Ctrl+G)
bind '"\C-g":"sesh connect \$(arashi list | fzf)\n"'
# zsh:
bindkey -s '^g' 'sesh connect $(arashi list | fzf)\n'
```

**Benefits of sesh:**

- Smart session naming and path handling
- Automatic tmux session creation
- Works seamlessly with zoxide and other tools

### Comparison Table

| Method            | Setup Complexity | Features             | Best For                          |
| ----------------- | ---------------- | -------------------- | --------------------------------- |
| **Basic fzf**     | Low              | Quick navigation     | Simple cd workflows               |
| **tmux function** | Medium           | Session management   | Multi-project work                |
| **sesh**          | Low-Medium       | Unified session list | Power users with multiple sources |

### Tips

- **Preview window:** Add `--preview 'cd {} && git status'` to fzf for live status
- **Layout:** Try `--preview-window=right:60%` for side-by-side preview
- **Height:** Use `--height=80%` to avoid fullscreen fzf
- **Multi-select:** Add `--multi` to fzf for batch operations

### Example Workflow

```bash
1. Run `arashi create feature-new-api` to set up worktrees across repos
1. Press Ctrl+G
2. Type "feature" to filter worktrees
3. Select your feature branch worktree
4. tmux session is created/attached
5. Start coding immediately!

# No more:
cd ~/projects/repo
cd ../feature-worktree
tmux new -s feature-branch
cd ~/projects/repo/feature-worktree
```

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

# Build for all platforms
bun run build:all

# Run tests (coming soon)
bun test

# Lint and format checks
bun run lint
bun run format:check

# Optional auto-fixes
bun run lint:fix
bun run format

# Changed-file quality checks
bun run quality:changed

# Type check
bun run typecheck
```

### Code Quality Workflow

- `bun run lint` runs Oxlint with repository rules and reports actionable diagnostics.
- `bun run format:check` validates formatting without writing changes.
- `bun run lint:fix` and `bun run format` apply automatic remediations when available.
- `bun run quality:changed` runs lint and format checks only on changed files for faster local feedback.
- CI enforces `typescript/no-explicit-any` as an error for repository linting.

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

## Why "Arashi"?

嵐 (Arashi) means "storm" in Japanese. This tool aims to be the calm center - the eye of the storm - that brings order to the chaos of managing multiple repositories and worktrees.

## License

MIT

---

**Note:** This project is under active development. Features and APIs may change.
