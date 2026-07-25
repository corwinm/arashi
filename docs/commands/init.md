# `arashi init`

Initialize a configured Arashi workspace, or reconcile the managed Git ignore preference of an
existing workspace.

```bash
arashi init
arashi init --worktrees-dir ../workspace-worktrees
arashi init --ignore-scope local
arashi init --ignore-scope tracked
arashi init --ignore-scope none
arashi init --dry-run --json
```

## Worktree location

Non-bare repositories default to `.arashi/worktrees`; bare repositories default to `..`.
An explicit `--worktrees-dir` takes precedence in either repository type. New or forced initialization
normalizes the selected value, which is persisted as `worktreesDir` in `.arashi/config.json`. Later
commands use that configured value rather than re-inferring repository type. Existing configs are
not migrated automatically, and `.arashi/worktrees` remains the compatibility fallback when a
legacy config omits the field.

## Managed ignore behavior

For non-bare configured init, `local` is the default and writes missing safe `reposDir` and
`worktreesDir` rules to the common repository's `info/exclude`. `tracked` opts this clone into an
Arashi-owned block in the workspace `.gitignore`. `none` persists a non-mutating preference and
reports paths that remain unignored. Selecting `local` removes the clone-local override.

Before writing in a non-bare repository, Arashi uses Git to detect effective tracked,
repository-local, and configured global rules. Existing effective rules are preserved without
duplication. Arashi never changes a global excludes file or global Git configuration, and it skips
repository root, absolute, and parent-traversal paths.

Bare configured init follows a non-worktree policy. It reports the parent default as external and
unsafe. Administrative subdirectories beneath the bare Git directory are non-applicable to working-tree ignore rules. Arashi does not run `git check-ignore` or write ignore files for those
paths under `local`, `tracked`, or `none`, regardless of whether the bare repository is linked,
committed without a linked worktree, or unborn.

`--dry-run` previews the resolved config and managed-path classifications without changing config,
hooks, repositories, worktrees, ignore files, or clone-local preference state. JSON mode returns the
same normalized `worktreesDir` and managed-ignore result in a single output envelope.
