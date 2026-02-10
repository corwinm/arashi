# Contributing to Arashi

Thanks for contributing.

## Workflow

1. Open or reference the related spec in the specs repository.
2. Create a feature branch in this repository.
3. Implement changes with tests.
4. Run local quality gates before pushing.
5. Open a pull request with links to related specification artifacts.

Specs repository: [github.com/corwinm/arashi-arashi](https://github.com/corwinm/arashi-arashi)

## Local Quality Gates

Run these before opening or updating a PR:

```bash
bun run lint
bun run format:check
bun test
bun run build
```

For faster iteration during active edits:

```bash
bun run quality:changed
```

## CI Quality Gate

CI enforces the same baseline through:

- `bun run lint:ci`
- `bun run format:check`
- `bun test`
- platform build validation

## Failure Remediation

If checks fail:

1. Run `bun run lint` for diagnostics.
2. Apply automatic fixes with `bun run lint:fix` and `bun run format`.
3. Re-run the full local quality gate.
4. Commit and push the fixes.
