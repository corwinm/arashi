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

When a branch already has an upstream, publishability is measured against that upstream. When it has no upstream and the configured workspace defines an effective `baseBranch`, publishability is measured against the refreshed configured remote base instead of the remote default. An unavailable configured base is reported and never silently replaced by the upstream or default. This comparison does not change the push destination: `--set-upstream` still publishes the current branch to the selected remote under its current name.

This keeps coordinated worktree symmetry from manufacturing remote branches for child repositories that were intentionally untouched.

`--dry-run` never updates remote branches. It may fetch a configured base into a local remote-tracking ref so the publishability plan is based on current remote state.

`--json` reserves stdout for exactly one JSON document. Skipped repositories are also reported as structured warnings so automation can decide whether to retry with flags such as `--only` or `--set-upstream`.
