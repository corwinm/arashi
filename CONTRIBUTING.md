# Contributing to Arashi

Thanks for contributing.

## Canonical Guide

Please use the primary contribution workflow in the specs repository:

- [`arashi-arashi/CONTRIBUTING.md`](https://github.com/corwinm/arashi-arashi/blob/main/CONTRIBUTING.md)

That guide defines the Arashi CLI worktree flow and agent-neutral OpenSpec planning process for Pi, OpenCode, and Hermes.

Repository development uses the guide's Node.js 24.18.0+ and pnpm 11.22.0 toolchain. The
`engines.node` range describes the installed npm launcher's runtime compatibility; it does not apply
to contributor scripts, because the pinned pnpm version itself requires a newer Node.js runtime.

## Implementation Quality Gates

For code changes in this repository, run:

```bash
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build
pnpm run contract:check
```

## CLI Command Contract

The checked-in `contracts/cli-commands.json` is generated from the same Commander tree used by
the runtime plus typed companion-surface policy in `src/contracts/cli-commands.ts`. When adding,
removing, or changing a command or option, update its semantic metadata (including reasons for
conditional JSON support, representations, and exclusions), then run:

```bash
pnpm run contract:generate
pnpm run contract:check
```

Commit the generated artifact with the source change. The freshness check is side-effect-free and
runs in CLI CI without requiring docs, skills, or VS Code sibling repositories.

Optional fast path during active edits:

```bash
pnpm run quality:changed
```

## Performance benchmarks

Run the opt-in, cross-platform CLI suite with `pnpm benchmark`. See
[`docs/performance-benchmarks.md`](docs/performance-benchmarks.md) for fixture definitions, result
fields, branch-comparison guidance, optional metrics, and the informational CI policy.
