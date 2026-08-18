# `aw push`

## Usage

```bash
aw push [options]
```

Publish eligible coordinated feature branches across the parent workspace and managed child repositories.

## Options

- `--only <repo>` include only a named repository. Repeat the flag for multiple repositories.
- `--set-upstream` publish branches that do not have upstream tracking and set that upstream.
- `--dry-run` preview planned pushes and skipped repositories without updating remotes.
- `--json` emit one machine-readable JSON envelope to stdout.

## Examples

```bash
# Publish eligible repos that already have upstream tracking
aw push

# Publish a new coordinated branch and set upstreams where needed
aw push --set-upstream

# Publish only one child repo
aw push --only arashi-docs --set-upstream

# Preview before publishing
aw push --set-upstream --dry-run

# Automation-safe output
aw push --set-upstream --json
```

## Behavior

`push` evaluates the current branch in each selected repository. Repositories with publishable local branch commits are pushed; repositories that are unchanged, already up to date, detached, missing remotes, or missing required upstream setup are skipped with a reason.

This keeps coordinated worktree symmetry from manufacturing remote branches for child repositories that were intentionally untouched.

`--dry-run` is a local, non-mutating preview. It reports the Git push commands Arashi would run, but it does not contact or update remotes.

`--json` reserves stdout for exactly one JSON document. Skipped repositories are also reported as structured warnings so automation can decide whether to retry with flags such as `--only` or `--set-upstream`.
