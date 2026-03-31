# Switch Command

Open a new terminal context in an existing worktree, or change the current shell directory when shell integration is active.

## Usage

```bash
arashi switch [filter] [options]
```

## Options

- `--sesh` Use `sesh` in tmux mode (requires active tmux session)
- `--cd` Request parent-shell directory switching for this invocation
- `--no-cd` Disable parent-shell directory switching for this invocation
- `--no-default-launch` Ignore configured switch launch-mode defaults for one invocation
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

# Change the current shell directory when shell integration is active
arashi switch feature-auth --cd

# Force launch behavior even if switch defaults prefer cd
arashi switch feature-auth --no-cd

# Ignore configured launch-mode defaults for one run
arashi switch --no-default-launch
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
- Shell integration is configured with `arashi shell install` or manual `arashi shell init <shell>` setup.
- Configure default switch behavior in `.arashi/config.json` under `defaults.switch.mode` (`launch`, `cd`, or `auto`).
- Configure default switch launch behavior in `.arashi/config.json` under `defaults.switch.launchMode`.
- `defaults.switch.mode: "auto"` prefers `cd` when shell integration is active and falls back to normal launch behavior otherwise.
- If `--cd` is used without active shell integration, Arashi warns and skips launch fallback for that invocation.
- If `defaults.switch.mode: "cd"` is configured without active shell integration, Arashi warns and then follows normal launch resolution.
