# Switch Command

Open a new terminal context in an existing worktree, or change the current shell directory when shell integration is active.

## Usage

```bash
arashi switch [filter] [options]
```

## Options

- `--tmux` Force a new plain tmux window for this invocation
- `--sesh` Use `sesh` in tmux mode (requires active tmux session)
- `--herdr` Open or focus the selected worktree in Herdr
- `--tab` Request a true terminal tab or managed-context equivalent for this invocation
- `--cd` Request parent-shell directory switching for this invocation
- `--no-cd` Disable parent-shell directory switching for this invocation
- `--no-default-launch` Bypass a configured `sesh` or `herdr` mode for one invocation
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

# Force a plain tmux window
arashi switch --tmux feature-auth

# Open or focus a persistent Herdr workspace
arashi switch feature-auth --herdr

# Request a tab/equivalent without window fallback
arashi switch feature-auth --tab

# Change the current shell directory when shell integration is active
arashi switch feature-auth --cd

# Force launch behavior even if switch defaults prefer cd
arashi switch feature-auth --no-cd

# Bypass a configured sesh or Herdr mode for one run
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
- Explicit `--tmux` is per-invocation only, requires `TMUX` to be non-empty after trimming, and does not fall back to another launcher. It conflicts with `--cd`, `--tmux --sesh`, `--herdr`, `--vscode`, `--cursor`, and `--kiro`; `--no-cd` and `--no-default-launch` are compatible and redundant because explicit tmux wins.
- `--json --tmux` returns one `JSON_UNSUPPORTED_FOR_MODE` envelope with the existing `launch` mode label before conflict or tmux-context validation.
- Inside a Herdr-launched shell (`HERDR_ENV=1`), Arashi automatically opens or focuses the selected target in Herdr unless an explicit launcher or active tmux takes precedence.
- Herdr launch requires the `herdr` CLI, a reachable default Herdr server/socket, and a Git-resolvable non-bare main checkout. Arashi calls `herdr worktree open`; it does not delegate Git worktree creation or removal to Herdr.
- Managed Kitty selection applies when any one of `KITTY_PID`, `KITTY_WINDOW_ID`, or normalized `TERM=xterm-kitty` is non-empty/present. Once selected, the managed workflow fails closed.
- Managed Kitty requires Kitty 0.43 or newer and permitted `kitten @` remote control. Arashi queries for its exact worktree marker, focuses and reuses one matching tab, and launches a session-backed tab only when no exact match exists. Duplicate matches fail safely.
- Once managed Kitty is selected, missing or unsupported tooling, denied remote control, malformed state, locking failures, and focus/launch validation errors are reported directly rather than falling back to another launcher.
- In Kitty, Ghostty, WezTerm, and iTerm2 terminals without a strict managed context, Arashi may still attempt terminal-native launch commands during generic fallback behavior.
- Shell integration is configured with `arashi shell install` or manual `arashi shell init <shell>` setup.
- Configure one default under `defaults.switch.mode`: `auto` | `cd` | `launch` | `sesh` | `herdr`.
- `auto` checks strict managed contexts in the order tmux → Herdr → cmux → integrated IDE → managed Kitty. If none is detected, it uses parent-shell `cd` when available, then terminal/platform launch fallback.
- An absent mode preserves built-in automatic `launch` behavior and does not newly prefer `cd`.
- Explicit launcher flags take precedence over `--cd` / `--no-cd`, configured modes, and automatic context detection. Conflicting explicit launchers and `--cd` plus any explicit launcher are rejected.
- `--tab` is CLI-only and never persisted. It expresses launch intent, overrides automatic/configured parent-shell `cd`, composes with explicit launcher selectors, and never falls back to a window or another launcher. Unsupported selected adapters return `TAB_DISPOSITION_UNSUPPORTED`; runtime/preflight launch failures return `LAUNCH_FAILED`. `--tab --json` returns `JSON_UNSUPPORTED_FOR_MODE` before contextual validation.
- Legacy switch `launchMode` and `launch_mode` fields are accepted only for a bounded compatibility window. Follow the exact replacement warning on stderr; ambiguous or conflicting combinations are rejected before switching.
- If `--cd` is used without active shell integration, Arashi warns and skips launch fallback for that invocation.
- If `defaults.switch.mode: "cd"` is configured without active shell integration, Arashi warns and then follows normal launch resolution.
