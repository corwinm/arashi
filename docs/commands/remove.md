# Remove Command

Remove worktrees and delete branches across the workspace with a single command.

## Usage

```bash
arashi remove [branch] [options]
```

## Options

- `--no-check-dirty` Skip uncommitted changes check
- `--keep-worktrees` Delete branches but keep worktree directories
- `--keep-branches` Remove worktrees but keep git branches
- `-f, --force` Skip confirmation prompts
- `--json` Output results as JSON

## Examples

```bash
# Remove a single branch with confirmation
arashi remove feature-login

# Interactive multi-select removal
arashi remove

# Skip dirty checks
arashi remove feature-login --no-check-dirty

# Keep worktree directories
arashi remove feature-login --keep-worktrees

# Keep git branches
arashi remove feature-login --keep-branches

# Machine-readable output
arashi remove feature-login --json
```

## Notes

- The command skips main worktrees automatically.
- Dirty worktrees require explicit confirmation unless `--no-check-dirty` is set.
- Use `--keep-worktrees` or `--keep-branches` for selective removal. Using both performs no operations.

## Remove Lifecycle Hooks

Global remove hooks can be defined under `.arashi/hooks/`:

- `pre-remove.sh`
- `post-remove.sh`

Behavior:

- `pre-remove.sh` runs after confirmation and before destructive operations.
- if `pre-remove.sh` fails, remove operations are aborted.
- `post-remove.sh` runs after remove operations are attempted, including partial-failure runs.
- if `post-remove.sh` fails, the command reports the hook error and exits non-zero.

Common use cases include session teardown (for example tmux cleanup), external cache cleanup, and follow-up notifications.
