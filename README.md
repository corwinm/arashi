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

## Integration with fzf, tmux, and sesh

The `arashi list` command outputs clean, full paths perfect for piping to tools like fzf. Here are powerful workflow integrations:

### Basic: Change Directory with fzf

Navigate to any worktree interactively:

```bash
# Interactive worktree selection
cd $(arashi list | fzf)
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

```bash
# Install sesh
brew install joshmedeski/sesh/sesh

# Add arashi as a sesh source
# ~/.config/sesh/sesh.toml
[sources]
arashi = "arashi list"
```

#### Usage

```bash
# Select from all sessions + arashi worktrees
sesh connect $(sesh list | fzf)

# Or create a keybinding (Ctrl+A)
bind '"\C-a":"sesh connect \$(sesh list | fzf)\n"'
```

**Benefits of sesh:**
- Unified list of existing tmux sessions + arashi worktrees
- Smart session naming and path handling
- Automatic tmux session creation
- Works seamlessly with zoxide and other tools

### Fish + tmux Integration

For Fish shell users, here's a complete solution:

```fish
# ~/.config/fish/functions/arashi_session.fish
function arashi_session
    set -l worktree (arashi list | fzf \
        --preview 'cd {} && git status' \
        --preview-window=right:60% \
        --height=80%)
    
    if test -n "$worktree"
        set -l session_name (basename $worktree)
        
        if not tmux has-session -t $session_name 2>/dev/null
            tmux new-session -d -s $session_name -c $worktree
        end
        
        if set -q TMUX
            tmux switch-client -t $session_name
        else
            tmux attach-session -t $session_name
        end
    end
end

# Bind to Ctrl+G
bind \cg arashi_session
```

This includes:
- Live git status preview in fzf
- Automatic session creation with smart naming
- Works both inside and outside tmux

### Comparison Table

| Method | Setup Complexity | Features | Best For |
|--------|-----------------|----------|----------|
| **Basic fzf** | Low | Quick navigation | Simple cd workflows |
| **tmux function** | Medium | Session management | Multi-project work |
| **sesh** | Low-Medium | Unified session list | Power users with multiple sources |

### Tips

- **Preview window:** Add `--preview 'cd {} && git status'` to fzf for live status
- **Layout:** Try `--preview-window=right:60%` for side-by-side preview
- **Height:** Use `--height=80%` to avoid fullscreen fzf
- **Multi-select:** Add `--multi` to fzf for batch operations

### Example Workflow

```bash
# Morning routine:
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
