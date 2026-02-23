# Hooks

Arashi supports lifecycle hooks to customize create and remove workflows.

## Hook Locations

### `arashi create`

Create hooks are discovered from the workspace root `.arashi/hooks/` directory:

- `pre-create.sh` runs once before any worktrees are created.
- `post-create.sh` runs once after create processing completes.
- `pre-create.<child-repo>.sh` runs for a specific child repository.
- `post-create.<child-repo>.sh` runs for a specific child repository.

### `arashi remove`

Remove hooks are discovered per target repository from scoped locations:

1. Repository scope: `<workspace>/repos/<repo>/.arashi/hooks/<lifecycle>.sh`
2. Workspace-root scope: `<workspace>/.arashi/hooks/<lifecycle>.sh`
3. Global scope (repository-targeted): `~/.arashi/hooks/<repo>/<lifecycle>.sh`
4. Global scope (shared): `~/.arashi/hooks/<lifecycle>.sh`

Supported remove lifecycles:

- `pre-remove.sh`
- `post-remove.sh`

## Execution Order

### `arashi create`

1. Global `pre-create.sh`
2. Repo-specific `pre-create.<child-repo>.sh`
3. Repo-specific `post-create.<child-repo>.sh`
4. Global `post-create.sh`

### `arashi remove`

For each targeted repository, hooks run in this order:

1. Repository scope
2. Workspace-root scope
3. Global repository-targeted scope
4. Global shared scope

Lifecycle timing:

1. Confirmation (unless `--force`)
2. All discovered `pre-remove` hooks in scope order
3. Worktree removals and branch deletions
4. All discovered `post-remove` hooks in scope order

## Failure Behavior

- If any create hook fails, create stops and `post-create.sh` does not run.
- If any discovered `pre-remove` hook fails or times out, remove operations are aborted before destructive actions.
- `post-remove` hooks run after remove attempts complete, including partial-failure runs.
- If any discovered `post-remove` hook fails or times out, `arashi remove` exits non-zero.
- Missing hooks are reported as `skipped (not_found)`.

## Context and Environment

Hooks run with `ARASHI_*` environment variables.

Common variables:

- `ARASHI_HOOK_NAME`
- `ARASHI_REPO_PATH`
- `ARASHI_MAIN_REPO_PATH`

Remove hooks additionally receive aggregate targets:

- `ARASHI_OPERATION` (`remove`)
- `ARASHI_REMOVE_TARGET_BRANCHES`
- `ARASHI_REMOVE_TARGET_WORKTREES`
- `ARASHI_REMOVE_TARGET_REPOSITORIES`
- `ARASHI_REMOVE_TOTAL_BRANCHES`
- `ARASHI_REMOVE_TOTAL_WORKTREES`
- `ARASHI_REMOVE_TOTAL_REPOSITORIES`

Scoped remove hooks also receive:

- `ARASHI_HOOK_SCOPE` (`repository`, `workspace`, `global-repository`, `global-shared`)
- `ARASHI_HOOK_SOURCE_PATH`
- `ARASHI_HOOK_TARGET_REPOSITORY`
- `ARASHI_HOOK_TARGET_REPO_PATH`

Working directory rules for remove hooks:

- Repository scope hooks run in the child repository path.
- Workspace-root scope hooks run in the workspace root path.
- Global hooks run in the target repository path.
