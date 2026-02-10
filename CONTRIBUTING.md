# Contributing to Arashi

Thanks for contributing.

## Canonical Guide

Please use the primary contribution workflow in the specs repository:

- [`arashi-arashi/CONTRIBUTING.md`](https://github.com/corwinm/arashi-arashi/blob/main/CONTRIBUTING.md)

That guide defines the Arashi CLI worktree flow, spec-kit process in OpenCode, and model preferences.

## Implementation Quality Gates

For code changes in this repository, run:

```bash
bun run lint
bun run format:check
bun test
bun run build
```

Optional fast path during active edits:

```bash
bun run quality:changed
```
