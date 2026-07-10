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
bun run contract:check
```

## CLI Command Contract

The checked-in `contracts/cli-commands.json` is generated from the same Commander tree used by
the runtime plus typed companion-surface policy in `src/contracts/cli-commands.ts`. When adding,
removing, or changing a command or option, update its semantic metadata (including reasons for
conditional JSON support, representations, and exclusions), then run:

```bash
bun run contract:generate
bun run contract:check
```

Commit the generated artifact with the source change. The freshness check is side-effect-free and
runs in CLI CI without requiring docs, skills, or VS Code sibling repositories.

Optional fast path during active edits:

```bash
bun run quality:changed
```
