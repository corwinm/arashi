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
- `--dry-run` Preview planned removals without changing worktrees, branches, or hooks
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

# Preview cleanup before deleting anything
arashi remove feature-login --dry-run

# Machine-readable preview for automation
arashi remove feature-login --dry-run --json

# Machine-readable output
arashi remove feature-login --json
```

## Notes

- The command skips main worktrees automatically.
- Dirty worktrees require explicit confirmation unless `--no-check-dirty` is set.
- Use `--dry-run` when you want to see planned worktree removals, branch deletions, dirty blockers, skipped/missing repositories, and hook context before mutation.
- `--dry-run` never removes worktrees, deletes branches, detaches kept worktrees, or executes remove hooks.
- Use `--keep-worktrees` or `--keep-branches` for selective removal. Using both performs no operations.

## Remove Lifecycle Hooks

Remove hooks can be defined at four scopes:

- Repository scope: `repos/<repo>/.arashi/hooks/pre-remove<ext>` and `post-remove<ext>`
- Workspace-root scope: `.arashi/hooks/pre-remove<ext>` and `post-remove<ext>`
- Global scope:
  - repository-targeted: `~/.arashi/hooks/<repo>/pre-remove<ext>` and `post-remove<ext>`
  - shared: `~/.arashi/hooks/pre-remove<ext>` and `post-remove<ext>`

`<ext>` is `.sh` on POSIX or one case-insensitive `.ps1`, `.cmd`, or `.bat` on Windows. Multiple
native candidates fail preflight before removal mutation.

Behavior:

- For each targeted repository, hooks run in order: repository -> workspace-root -> global targeted -> global shared.
- `pre-remove.sh` runs after confirmation and before destructive operations.
- `--dry-run` reports configured remove hooks that would be considered, but does not execute hook scripts.
- If any discovered `pre-remove` hook fails, remove operations are aborted.
- `post-remove.sh` runs after remove operations are attempted, including partial-failure runs.
- If any discovered `post-remove` hook fails, the command reports hook errors and exits non-zero.
- Hook scope metadata is available via `ARASHI_HOOK_SCOPE` and `ARASHI_HOOK_SOURCE_PATH`.
- Hook context is target-consistent for each repository invocation. Parse
  `ARASHI_REMOVE_TARGETS_JSON` for the canonical command-wide target list; comma-separated aggregate
  fields are lossy 1.x compatibility values.
- Hooks default to 300000 ms; configured workspaces may set `hooks.timeout` to an integer from 1
  through 2147483647.
- JSON success stores the ordered ledger at `data.hookOutcomes`; failure stores it at
  `error.details.hookOutcomes` alongside removal errors.

Common use cases include session teardown (for example tmux cleanup), external cache cleanup, and follow-up notifications.
