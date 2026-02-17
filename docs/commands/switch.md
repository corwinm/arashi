# Switch Command

Open a new terminal context in an existing worktree.

## Usage

```bash
arashi switch [filter] [options]
```

## Options

- `--sesh` Use `sesh` in tmux mode (requires active tmux session)
- `--repos` Search child repositories in the current workspace only
- `--all` Search parent + child repositories

## Examples

```bash
# Choose from parent repository worktrees
arashi switch

# Choose from child repository worktrees only
arashi switch --repos

# In --repos mode, filter matches repository names first
arashi switch --repos docs

# Choose across parent + child worktrees
arashi switch --all

# Filter by branch or path text
arashi switch feature-auth

# Use sesh/tmux switching mode
arashi switch feature-auth --sesh
```

## Notes

- If one target matches, Arashi switches immediately.
- If multiple targets match in an interactive terminal, Arashi prompts for selection.
- In non-interactive mode with multiple matches, provide a narrower filter.
- By default, `arashi switch` targets parent repository worktrees only.
- Use `--repos` for child repos in the current workspace, or `--all` for parent + child repos across workspaces.
- `--all` includes parent workspaces and child repo worktrees nested under each parent workspace.
- In `--repos` mode, filter text matches repository names first (exact match wins; a unique partial match is auto-selected).
- If `--repos` has no repository matches, Arashi prints available child repositories.
- Inside tmux, Arashi opens a new tmux window automatically.
- In Kitty, Ghostty, WezTerm, and iTerm2 terminals, Arashi attempts terminal-native launch commands before generic fallback behavior.
