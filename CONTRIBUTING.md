# Contributing to Arashi

Thanks for contributing to Arashi.

## Quality Gate Expectations

All pull requests must pass the CI quality gate before merge. The gate includes:

- `bun run lint:ci`
- `bun run format:check`

CI also runs tests and build jobs after quality checks succeed.

## Local Pre-PR Workflow

Run the same quality commands locally before opening or updating a pull request:

```bash
bun run lint
bun run format:check
bun test
bun run build
```

For faster iteration during active changes, run:

```bash
bun run quality:changed
```

CI enforces `typescript/no-explicit-any` as an error across repository lint checks.

## Failure Remediation

If CI fails on quality checks:

1. Run `bun run lint` to view file-level diagnostics.
2. Run `bun run lint:fix` to apply auto-fixes where possible.
3. Run `bun run format` to apply formatting updates.
4. Re-run `bun run lint` and `bun run format:check`.
5. Commit fixes and push updates.

If a lint failure is not auto-fixable, update the flagged code manually based on the reported rule and location.
