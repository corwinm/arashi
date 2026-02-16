# Hooks

Arashi supports lifecycle hooks to customize worktree creation workflows.

## Hook Locations

Place hook scripts under `.arashi/hooks/` in the main repository:

- `pre-create.sh` runs once before any worktrees are created.
- `post-create.sh` runs once after all worktrees and other hooks complete.
- `pre-create.<child-repo>.sh` runs after the child worktree exists and before the repo-specific post-create hook.
- `post-create.<child-repo>.sh` runs after the repo-specific pre-create hook.

When `arashi create` is invoked from a managed child repository (or any nested path inside it), hook lookup still resolves from the canonical workspace root. You do not need to duplicate hook files inside child repositories.

## Execution Order

1. Global `pre-create.sh`
2. Repo-specific `pre-create.<child-repo>.sh`
3. Repo-specific `post-create.<child-repo>.sh`
4. Global `post-create.sh`

## Failure Behavior

- If any hook fails, the create operation stops immediately and the global post-create hook does not run.
- Failed runs continue to use rollback safeguards so partial worktrees are cleaned up.
- Output includes per-repository hook status lines with explicit terminal states: `success`, `failure`, or `skipped`.
- Missing repo-specific hooks are reported as `skipped (not_found)` instead of being silent.
- Timeout or non-zero exit failures include actionable next-step guidance.

## Context and Environment

Repo-specific hooks run with the working directory set to the new child worktree and receive these environment variables:

- `ARASHI_BRANCH_NAME`
- `ARASHI_REPO_NAME`
- `ARASHI_WORKTREE_PATH`
- `ARASHI_MAIN_REPO_PATH`
- `ARASHI_PARENT_REPO_PATH`

Global hooks run in the main repo context.
