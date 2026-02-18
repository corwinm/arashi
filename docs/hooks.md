# Hooks

Arashi supports lifecycle hooks to customize create and remove workflows.

## Hook Locations

Place hook scripts under `.arashi/hooks/` in the main repository:

- `pre-create.sh` runs once before any worktrees are created.
- `post-create.sh` runs once after all create hooks complete.
- `pre-remove.sh` runs once before remove operations begin.
- `post-remove.sh` runs once after remove operations are attempted.
- `pre-create.<child-repo>.sh` runs after the child worktree exists and before the repo-specific post-create hook.
- `post-create.<child-repo>.sh` runs after the repo-specific pre-create hook.

When `arashi create` or `arashi remove` is invoked from a managed child repository (or any nested path inside it), hook lookup still resolves from the canonical workspace root.

## Execution Order

### `arashi create`

1. Global `pre-create.sh`
2. Repo-specific `pre-create.<child-repo>.sh`
3. Repo-specific `post-create.<child-repo>.sh`
4. Global `post-create.sh`

### `arashi remove`

1. Confirmation (unless `--force`)
2. Global `pre-remove.sh`
3. Worktree removals and branch deletions
4. Global `post-remove.sh`

Remove hooks are global-only in this release (no repo-specific remove hook variants).

## Failure Behavior

- If any create hook fails, the create operation stops and the global post-create hook does not run.
- If `pre-remove.sh` fails, remove operations are aborted before destructive actions.
- `post-remove.sh` still runs after partial remove failures to allow cleanup/finalization.
- If `post-remove.sh` fails, `arashi remove` exits non-zero.
- Missing hooks are reported as `skipped (not_found)`.

## Context and Environment

Hooks run with `ARASHI_*` environment variables.

Create hooks commonly use:

- `ARASHI_BRANCH_NAME`
- `ARASHI_REPO_NAME`
- `ARASHI_WORKTREE_PATH`
- `ARASHI_MAIN_REPO_PATH`
- `ARASHI_PARENT_REPO_PATH`

Remove hooks additionally receive aggregate targets:

- `ARASHI_OPERATION` (`remove`)
- `ARASHI_REMOVE_TARGET_BRANCHES`
- `ARASHI_REMOVE_TARGET_WORKTREES`
- `ARASHI_REMOVE_TARGET_REPOSITORIES`
- `ARASHI_REMOVE_TOTAL_BRANCHES`
- `ARASHI_REMOVE_TOTAL_WORKTREES`
- `ARASHI_REMOVE_TOTAL_REPOSITORIES`

Global hooks run in the main repo context. Repo-specific create hooks run with the working directory set to the new child worktree.
