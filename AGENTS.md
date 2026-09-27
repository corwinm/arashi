# Arashi CLI Agent Rules

This repository contains the Arashi CLI implementation.

## Scope

- Put CLI source changes in `src/`.
- Put tests in `tests/`.
- Keep user guides canonical at https://arashi.haphazard.dev (source: `arashi-docs`).
- Keep the README as a concise entry point; reserve `docs/` for CLI maintainer internals.

## Working Rules

- Keep changes minimal and command-accurate.
- Follow existing Bun and TypeScript patterns already in the repo.
- If command behavior, configuration, hooks, or user workflow changes, review whether `repos/arashi-docs/` and `repos/arashi-skills/` also need updates.

## Validation

- `pnpm run lint`
- `pnpm run test`
- `pnpm run build`
