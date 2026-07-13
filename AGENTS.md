# Arashi CLI Agent Rules

This repository contains the Arashi CLI implementation.

## Scope

- Put CLI source changes in `src/`.
- Put tests in `tests/`.
- Keep CLI-specific docs in this repo's `README.md` or `docs/`.

## Working Rules

- Keep changes minimal and command-accurate.
- Follow existing Bun and TypeScript patterns already in the repo.
- If command behavior, configuration, hooks, or user workflow changes, review whether `repos/arashi-docs/` and `repos/arashi-skills/` also need updates.

## Validation

- `pnpm run lint`
- `pnpm run test`
- `pnpm run build`
