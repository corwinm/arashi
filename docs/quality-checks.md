# Quality Checks Troubleshooting

Use this guide when lint or format checks fail locally or in CI.

## Common Failures

### Lint violations

- Run `pnpm run lint` to view diagnostics.
- Run `pnpm run lint:fix` to apply automatic fixes.
- Manually resolve remaining violations and rerun `pnpm run lint`.

### Formatting failures

- Run `pnpm run format:check` to confirm non-compliant files.
- Run `pnpm run format` to apply formatting.
- Re-run `pnpm run format:check` to verify a clean result.

### Changed-file checks report no targets

- `pnpm run quality:changed` uses `git diff --name-only --diff-filter=ACMR HEAD`.
- Ensure files are modified relative to `HEAD`.
- Stage or edit files, then rerun the command.

### CI passes locally but fails in pull request

- Ensure dependencies match lockfile state by running `pnpm install`.
- Run `pnpm run lint:ci` locally to mirror CI lint output mode.
- Confirm generated or vendored files are not included in quality scope.

## Recommended Validation Sequence

```bash
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build
```

Run this sequence before opening a pull request to minimize CI failures.
