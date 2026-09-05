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

## Retained process-test binary opt-in

`tests/helpers/node-runtime.ts` substitutes an explicit absolute `ARASHI_TEST_BINARY` only for direct `[process.execPath | "node", <this checkout's src/index.ts>, ...args]` invocations. Relative entry paths resolve against the child cwd. With the variable unset, source execution is unchanged. Arguments and process options pass through to the existing runtime. Non-CLI Node commands, runtime-flag wrappers, Git commands, PTY outer wrappers, and direct `node:child_process` calls are not redirected. In-process TypeScript tests remain source tests; this is not whole-suite native coverage.

Reproduce the selected retained tests against source, then native (use `.exe` on Windows):

```sh
unset ARASHI_TEST_BINARY
node node_modules/vitest/vitest.mjs run tests/integration/standalone-lifecycle.test.ts -t 'bootstraps, creates slash path, lists/statuses from linked worktree, and removes'
node node_modules/vitest/vitest.mjs run tests/integration/init.zero-config.test.ts -t 'creates only the convention|preserves no-final-newline|honors an existing tracked|preserves CRLF'
export ARASHI_TEST_BINARY="$PWD/target/release/arashi"
# Repeat the same two commands with this explicit opt-in.
unset ARASHI_TEST_BINARY
```

These five tests cover standalone bootstrap/ignore bytes and idempotence, slash-path create, linked list/status and forced removal. The explicit filters deselect 69 lifecycle and 18 init tests; those are not native coverage. No source/native differences were observed in this slice. Hooks, materialization, PTY interaction and direct child_process suites remain outside this batch.

## Latest local verification

Verified locally on macOS, 2026-09-04, with `CARGO_HOME="$PWD/target/cargo-home"` and Cargo `--offline`:

- `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo build --locked --release`: exit 0.
- `ARASHI_TS_PARITY=1 cargo test --locked --all-targets -- --include-ignored --test-threads=4`: **88 passed, 0 failed, 0 ignored**. Log: `target/rust-tests.log`.
- `node tests/rust/parity.mjs target/release/arashi target/source-parity.json`: **15/15 passed**, full output and effects comparisons.
- `node node_modules/vitest/vitest.mjs run tests/unit/node-runtime.test.ts`: runner tests were written first: **3 failed, 2 passed** before substitution (`target/node-runtime-red.log`); **6/6 passed** after implementation and added child-cwd coverage (`target/node-runtime-green.log`). Async/sync executable probes verify cwd, env, streams and exit codes.
- The five retained tests above passed against source and native. Reports: `target/retained-{source,native}.log` and `target/retained-init-{source,native}.log`.
- `pnpm run lint`: exit 0, 3279 warnings, zero errors. `pnpm run build`: exit 0. pnpm used invocation-only `pnpm_config_verify_deps_before_run=false` with existing dependencies.
- `pnpm run test`: **2966 passed, 2 failed, 17 skipped**, exit 1 (`target/ts-tests.log`). The handoff Markdown warning assertion inherited `NO_COLOR` and received `[WARN]` instead of `⚠`; the installer SIGINT PTY test was denied `/dev/tty` by the sandbox. Both passed unchanged in focused reruns (1 test each):
  - `env -u NO_COLOR -u ARASHI_TEST_BINARY node node_modules/vitest/vitest.mjs run tests/integration/handoff.test.ts -t 'keeps explicit --markdown equivalent'` (`target/ts-handoff-rerun.log`).
  - `env -u ARASHI_TEST_BINARY node node_modules/vitest/vitest.mjs run tests/integration/posix-installer-transaction.test.ts -t 'rolls back a foreground transaction when Ctrl-C delivers SIGINT'`, with terminal access outside the sandbox (`target/ts-pty-rerun.log`).
- `git diff --check`: exit 0. No failures were removed from the full test selection; the two focused reruns do not constitute another full-suite run.

Windows CI run [33950410399](https://github.com/corwinm/arashi/actions/runs/33950410399) at `010a4ea` supplied RED evidence: six Git worktree-add fixture failures from verbatim paths and two path assertions. All seven Rust fixture constructors now convert canonical filesystem paths to native drive/UNC paths; JSON comparisons are not globally normalized. Git-provided list/status row paths retain Git spelling. Production canonical-path comparisons and standalone init root reporting use the same conversion; status matches caller paths using filesystem path components. Regressions cover canonical configured init, linked caller status, caller-containing removal protection in both workspace modes, and Windows drive/UNC/device-prefix conversion. Windows-specific tests require a Windows rerun; macOS results do not establish Windows GREEN.

Downstream arashi-docs/arashi-skills were reviewed for scope: this batch changes test infrastructure and fixes existing native path behavior, without adding a published workflow. Those repositories remain outside the authorized worktree. No commits, signing changes, stable npm/shell release changes or cross-worktree edits were made.
