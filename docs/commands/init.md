# `aw init`

Initialize a configured Arashi workspace, or reconcile the managed Git ignore preference of an
existing workspace.

```bash
aw init
aw init --worktrees-dir ../workspace-worktrees
aw init --ignore-scope local
aw init --ignore-scope tracked
aw init --ignore-scope none
aw init --dry-run --json
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

## Generated examples

Lifecycle examples are inert. On POSIX, activate exactly one example and set its executable mode:

```sh
install -m 755 .arashi/hooks/pre-create.sh.example .arashi/hooks/pre-create.sh
```

Repository-specific examples use names such as `post-create.<repo>.sh.example`; replace `<repo>` in
the active destination and copy only the lifecycle you intend to trust:

```sh
install -m 755 '.arashi/hooks/post-create.<repo>.sh.example' .arashi/hooks/post-create.api.sh
```

Windows init produces inert PowerShell lifecycle examples, including `post-create.REPO.ps1.example`.
Replace `REPO` in repository-specific destinations and activate one with `Copy-Item`:

```powershell
Copy-Item .arashi/hooks/pre-create.ps1.example .arashi/hooks/pre-create.ps1
Copy-Item .arashi/hooks/post-create.REPO.ps1.example .arashi/hooks/post-create.api.ps1
```

Runtime discovery also supports a user-authored `.cmd` or `.bat` candidate instead of `.ps1`; only
one native candidate may exist for a logical location.

The POSIX setup example is `.arashi/setup.sh.example`; activating it as `.arashi/setup.sh` uses the
existing setup discovery path. Windows init omits this POSIX-only setup example. Setup is distinct
from lifecycle hooks and does not promise lifecycle environment variables or alter `core.hooksPath`.
