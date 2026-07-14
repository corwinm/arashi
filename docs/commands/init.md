# `arashi init`

Initialize a configured Arashi workspace, or reconcile the managed Git ignore preference of an
existing workspace.

```bash
arashi init
arashi init --ignore-scope local
arashi init --ignore-scope tracked
arashi init --ignore-scope none
arashi init --dry-run --json
```

`local` is the default and writes missing safe `reposDir` and `worktreesDir` rules to the common
repository's `info/exclude`. `tracked` opts this clone into an Arashi-owned block in the workspace
`.gitignore`. `none` persists a non-mutating preference and reports paths that remain unignored.
Selecting `local` removes the clone-local override.

Before writing, Arashi uses Git to detect effective tracked, repository-local, and configured
global rules. Existing effective rules are preserved without duplication. Arashi never changes a
global excludes file or global Git configuration, and it skips repository root, absolute, and
parent-traversal paths. `--dry-run` previews the structured plan without changing ignore files or
local preference state.
