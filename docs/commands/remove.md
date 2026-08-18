# Remove Command

Remove worktrees and delete branches across the workspace with a single command.

## Usage

```bash
aw remove [branch] [options]
```

## Options

- `--no-check-dirty` Skip uncommitted changes check
- `--keep-worktrees` Delete branches but keep worktree directories
- `--keep-branches` Remove worktrees but keep git branches
- `-f, --force` Skip confirmation prompts
- `--dry-run` Preview planned removals and source-aware hooks without changing worktrees or branches
- `--no-hook-input` Run hooks with input disabled and immediate EOF; hooks are not skipped
- `--json` Output results as one JSON document

## Examples

```bash
# Remove a single branch with confirmation
aw remove feature-login

# Interactive multi-select removal
aw remove

# Skip dirty checks
aw remove feature-login --no-check-dirty

# Keep worktree directories
aw remove feature-login --keep-worktrees

# Keep git branches
aw remove feature-login --keep-branches

# Preview cleanup before deleting anything
aw remove feature-login --dry-run

# Machine-readable preview for automation
aw remove feature-login --dry-run --json

# Machine-readable output
aw remove feature-login --json
```

## Notes

- The command skips main worktrees automatically.
- Removing a configured parent worktree automatically includes every configured descendant worktree nested beneath it, even when a descendant uses a different branch name. Descendants are always removed before their ancestors.
- Unless `--keep-branches` is set, branches belonging to automatically included descendants are also deleted from their owning repositories. Same-named branches in unrelated repositories are not included.
- `--dry-run` reports this complete child-first descendant plan without changing worktrees, branches, or hooks.
- If any configured repository is missing or cannot be inspected, coordinated worktree removal fails before mutation. An unavailable repository can still own a registered descendant at an arbitrary path beneath a selected ancestor, so absence alone is not sufficient proof that removal is safe.
- After pre-remove hooks finish, the planned hierarchy is revalidated before mutation. If a hook introduces an unplanned configured descendant, worktree and branch removal stop before changing the planned targets.
- Dirty worktrees require explicit confirmation unless `--no-check-dirty` is set.
- Use `--dry-run` when you want to see planned worktree removals, branch deletions, dirty blockers, skipped/missing repositories, and hook context before mutation.
- `--dry-run` never removes worktrees, deletes branches, detaches kept worktrees, or executes remove hooks.
- Use `--keep-worktrees` or `--keep-branches` for selective removal. Using both performs no operations.

## Remove Lifecycle Hooks

Remove hooks can be defined at four scopes:

- Repository scope: inline `repos.<name>.hooks.pre-remove|post-remove` or
  `repos/<repo>/.arashi/hooks/pre-remove<ext>` and `post-remove<ext>` files
- Workspace-root scope: inline root `hooks.scripts.pre-remove|post-remove` or
  `.arashi/hooks/pre-remove<ext>` and `post-remove<ext>` files
- Global scope (file-only):
  - repository-targeted: `~/.arashi/hooks/<repo>/pre-remove<ext>` and `post-remove<ext>`
  - shared: `~/.arashi/hooks/pre-remove<ext>` and `post-remove<ext>`

Each repository/workspace location uses either its inline value or native file. If both claim the same
logical location, remove fails preflight and runs neither. Different scopes retain repository →
workspace-root → global targeted → global shared order.

`<ext>` is `.sh` on POSIX or one case-insensitive `.ps1`, `.cmd`, or `.bat` on Windows. Multiple
native candidates fail preflight before removal mutation.

Behavior:

- For each targeted repository, hooks run in order: repository -> workspace-root -> global targeted -> global shared.
- `pre-remove` runs after confirmation and before destructive operations; any failure gates all removal mutation.
- `--dry-run` resolves the same source plan and previews inline/file kind, owner, lifecycle, scope,
  target, interpreter, and applicable file path, but never executes a hook or fabricates an outcome.
- Remove intentionally has no `--no-hooks`; use `--no-hook-input` only to disable hook input.
- `post-remove` runs after remove operations are attempted, continues across partial failures, and
  participates in failure finalization rather than rollback.
- Hook scope metadata is available via `ARASHI_HOOK_SCOPE`; `ARASHI_HOOK_SOURCE_PATH` exists only for
  file sources and is omitted for inline config.
- Hook context is target-consistent for each repository invocation. Parse
  `ARASHI_REMOVE_TARGETS_JSON` for the canonical command-wide target list; comma-separated aggregate
  fields are lossy 1.x compatibility values.
- Inline and file hooks share the default 300000 ms timeout; configured workspaces may set
  `hooks.timeout` to an integer from 1 through 2147483647.
- JSON owns quiet/progress isolation and writes one document. Success stores the ordered ledger at
  `data.hookOutcomes`; failure stores it at `error.details.hookOutcomes` alongside removal errors.
  Outcomes expose source kind/owner and nullable file path metadata, never configured snippet text.

Common use cases include session teardown (for example tmux cleanup), external cache cleanup, and follow-up notifications.
