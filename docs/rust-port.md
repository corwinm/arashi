# Rust port support ledger

The Rust binary is **2.0.0-alpha.1 and incomplete**. The retained TypeScript implementation is the behavioral oracle. npm remains 1.36.0; npm entrypoints, shell installers, stable release packaging, and TypeScript source remain unchanged. Rust binaries do not invoke TypeScript.

The complete parser inventory is [contracts/cli-commands.json](../contracts/cli-commands.json). Help registration does not imply implementation. Unsupported commands and policies fail nonzero; some alpha rejection and partial-failure envelopes intentionally differ from the source.

## Implemented scope

- **Discovery and list:** Configured primary/child and existing linked discovery; standalone discovery; ordinary Git `list` and `list --json` without `.worktrees`. Ordinary fallback applies only to list and does not enable standalone mutation. Configured/ordinary and standalone list shapes remain distinct. Verbose/table/depth options and bare topology remain unsupported.

- **Configured init:** Primary non-bare root; repository discovery or `--no-discover`; custom contained repos/worktrees directories; dry-run; source-identical config and platform hook-example bytes; local managed-ignore planning/application. Existing configuration reports the source error. Force, ignore-scope preferences/migration, stale owned ignore rules, non-Git bootstrap, linked/bare init and external paths remain unsupported.

- **Configured create:** Meta root and discovered children, selected-child-only creation, configured child paths and identities; `--only`/`--group`; default/branch/repo-branch naming and preserved/flattened slashes; local/default/explicit base resolution, configured workspace/repository bases and `--repo-base`; dry-run for conflict-free plans; explicit local branch reuse with `--conflict REUSE_EXISTING`; dirty-workspace guidance. Requires explicit `--no-hooks --no-launch --no-switch`. Materialization policies are rejected. Existing destinations, checked-out targets, remote-only target conflicts, conflict dry-run and automatic path-length fitting remain unsupported.

- **Configured remove:** Explicit branch target, child-before-parent Git worktree removal, configuration order, selected-child workspaces, missing-branch inventory, `--force`, `--keep-branches`, and dry-run pending-operation envelopes. Protects primary/locked/stale/caller-containing worktrees and unmanaged nested Git repositories. Actual removal requires `--force`; this authorizes discarding dirty target content. Hook execution, branch-only removal, path targeting, keep-worktrees/detach, no-check-dirty and interactive confirmation remain unsupported.

- **Standalone mutation:** Existing zero-config init/create/remove subset remains available, including ignore safety, local/remote-tracking branch reuse, create dry-run and keep-branches removal. This has separate eligibility and mutation rules from ordinary list.

- **Status:** Local configured parent/child and standalone JSON; configuration order; repeated/comma-separated only/group filters and exact selection errors; missing-child rows with source exit 1. Local filesystem `origin` remotes support upstream/default comparisons, including ahead counts and remote default-branch selection. Network/non-origin/multiple remotes, refresh-failure warning envelopes, configured base-comparison policies, linked execution-root projection, and short/verbose rendering remain unsupported.

- **Prune/install:** Existing standalone/configured metadata prune with dry-run and `--expire now`; informational direct-binary install contract. Other prune policies/topologies remain unsupported.

Create uses discovery order; status and removal retain configuration order. Status and create have different selection error contracts. No configured defaults are silently applied as successful launch/hook behavior: explicit create overrides are required for this subset.

## Mutation safety and remaining parity work

Plans check Git identity, branch/ref state, destinations, config and effective ignore policy before execution. Coordinated create records newly created branches before adding worktrees. Rollback removes worktrees through Git, preserves pre-existing branches, checks ownership before cleanup, and reports cleanup failures. File rollback preserves files changed after the transaction wrote them. Directory cleanup is limited to owned empty directories; production Rust does not recursively delete Git repositories.

This is not full failure parity. Coordinated mid-execution failures return nonzero alpha envelopes containing completed operations and rollback errors, rather than the complete source recovery contract. Concurrent external Git changes in the final validation-to-mutation window, partial filesystem writes, and complex mixed repository failures need more characterization. Hook/materialization rollback, configuration migrations, Unicode collision rules, stale ignore reconciliation, external/symlinked paths and bare/linked mutation topology remain blocking work.

Still unported: doctor, add/clone/delete, exec/setup, pull/push/sync, move/handoff, switch and terminal/editor integration, shell integration, completion/query, configure, update/uninstall and native distribution integration. Human init/create/remove/status text is not source-identical. Full parser/help/error precedence is not claimed. Hook policies and materialization require their real lifecycle, provenance, input, timeout and recovery contracts; empty success results are not substitutes.

Relevant source contracts: [configuration](../src/lib/config.ts), [create](../src/commands/create.ts), [remove](../src/commands/remove.ts), [managed ignore](../src/lib/managed-ignore.ts), [hooks](../src/lib/hooks.ts), [JSON envelopes](../src/lib/json-output.ts), [executable distribution](../contracts/executable-distribution.json). Downstream arashi-docs/arashi-skills need updates before publishing these workflows; they are outside this authorized child worktree and were not modified.

## Reproducible validation

```sh
# Keep Cargo registry/cache writes inside this checkout when required by the workspace sandbox.
export CARGO_HOME="$PWD/target/cargo-home"
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
ARASHI_TS_PARITY=1 cargo test --locked --all-targets -- --include-ignored --test-threads=4
cargo build --locked --release
node tests/rust/parity.mjs target/release/arashi target/native-smoke.json --native-only
node tests/rust/parity.mjs target/release/arashi target/source-parity.json
node tests/rust/parity.mjs target/release/arashi target/characterization.json --characterize
```

Use `.exe` on Windows. Source comparisons require installed Node/Bun project dependencies. The native-only journey requires Node and Git, but no TypeScript dependencies. `ARASHI_TS_SOURCE` can select an independent source entrypoint. The characterization mode additionally records known doctor discrepancies and deliberately exits nonzero while those differ.

The Rust oracle suite uses real temporary Git repositories and compares complete JSON envelopes, exit codes, Git state and file effects. Only elapsed durations are normalized. Native failure-injection tests cover rollback ownership, unmanaged nested repositories, unsupported policies and effective-ignore revalidation. The external Node harness saves raw source/native stdout, stderr, exits and effect snapshots in its report. It exercises configured init, parent plus two children, create dry-run/create, status/list from children, remove dry-run/remove and error cases. Test remotes are local; the Node harness restricts Git protocols to `file`.

[Experimental Rust CI](../.github/workflows/rust.yml) runs Cargo and the configured native release journey on Linux/macOS/Windows. A separate dependency-equipped job runs every source oracle and external release-binary parity, without silently skipping them. No release upload, installer or publication step is added.

## Latest local verification

Verified locally on macOS, 2026-09-04:

- `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo build --locked --release`: exit 0. Local Cargo invocations used the worktree-local cache and `--offline`.
- `ARASHI_TS_PARITY=1 cargo test --locked --all-targets -- --include-ignored --test-threads=4`: **82 passed, 0 failed, 0 ignored**. Full JSON and stderr comparisons remain enabled.
- External release-binary source parity: **15/15 passed**, including configured discovery file bytes and parent/two-child mutation effects. Report: `target/source-parity.json`.
- Native configured release journey: **12/12 passed**. Report: `target/native-smoke.json`. Existing Python standalone/alias/prune smoke also exited 0.
- Parent-provided independent characterization script: **14/18 matched**. Its four remaining differences are doctor from ordinary, configured, configured-child and outside contexts; script exit 1 is retained. Report: `target/independent-parity.json`.
- Full-output Node characterization: **15/19 matched**; only the four doctor cases differ. Unknown-option stderr now matches. Report: `target/characterization.json` (exit 1).
- `pnpm run lint`: exit 0, 3288 warnings, zero errors. `pnpm run build`: exit 0. `git diff --check`: exit 0. pnpm used the invocation-only `pnpm_config_verify_deps_before_run=false` setting with existing child-worktree dependencies.

Native safety regressions also verify stale destination registration rejection, same-named branch/tag identity, and rollback after native Git checkout-hook failure in standalone and configured creation. The unchanged TypeScript baseline passed 2962 tests, with 17 skipped. npm/shell distribution contracts and the TS oracle are retained; no production installation or release is changed. Remote CI is recorded separately on the v2 branch.
