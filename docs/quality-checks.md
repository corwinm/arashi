# Quality Checks Troubleshooting

Use this guide when lint or format checks fail locally or in CI.

## Common Failures

### Lint violations

- Run `bun run lint` to view diagnostics.
- Run `bun run lint:fix` to apply automatic fixes.
- Manually resolve remaining violations and rerun `bun run lint`.

### Formatting failures

- Run `bun run format:check` to confirm non-compliant files.
- Run `bun run format` to apply formatting.
- Re-run `bun run format:check` to verify a clean result.

### Changed-file checks report no targets

- `bun run quality:changed` uses `git diff --name-only --diff-filter=ACMR HEAD`.
- Ensure files are modified relative to `HEAD`.
- Stage or edit files, then rerun the command.

### CI passes locally but fails in pull request

- Ensure dependencies match lockfile state by running `bun install`.
- Run `bun run lint:ci` locally to mirror CI lint output mode.
- Confirm generated or vendored files are not included in quality scope.

## Recommended Validation Sequence

```bash
bun run lint
bun run format:check
bun test
bun run build
```

Run this sequence before opening a pull request to minimize CI failures.
