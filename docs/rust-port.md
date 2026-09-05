# Rust port support ledger

The Rust binary is **2.0.0-alpha.1 and incomplete**. The retained TypeScript implementation is the behavioral oracle. npm remains 1.36.0; npm entrypoints, shell installers, stable release packaging, and TypeScript source remain unchanged. Rust binaries do not invoke TypeScript.

The complete parser inventory is [contracts/cli-commands.json](../contracts/cli-commands.json). Help registration does not imply implementation. Unsupported commands and policies fail nonzero; some alpha rejection and partial-failure envelopes intentionally differ from the source.

## Implemented scope

- **Discovery and list:** Configured primary/child and existing linked discovery; standalone discovery; ordinary Git `list` and `list --json` without `.worktrees`. Ordinary fallback applies only to list and does not enable standalone mutation. Configured/ordinary and standalone list shapes remain distinct. Verbose/table/depth options and bare topology remain unsupported.

- **Configured init:** Primary non-bare root; repository discovery or `--no-discover`; custom contained repos/worktrees directories; dry-run; source-identical config and platform hook-example bytes; local managed-ignore planning/application. Existing configuration reports the source error. Force, ignore-scope preferences/migration, stale owned ignore rules, non-Git bootstrap, linked/bare init and external paths remain unsupported.

- **Configured create:** Meta root and discovered children, selected-child-only creation, configured child paths and identities; `--only`/`--group`; default/branch/repo-branch naming and preserved/flattened slashes; local/default/explicit base resolution, configured workspace/repository bases and `--repo-base`; dry-run for conflict-free plans; explicit local branch reuse with `--conflict REUSE_EXISTING`; dirty-workspace guidance. Requires explicit `--no-hooks --no-launch --no-switch`. Materialization policies are rejected. Existing destinations, checked-out targets, remote-only target conflicts, conflict dry-run and automatic path-length fitting remain unsupported.

- **Configured remove:** Explicit branch target, child-before-parent Git worktree removal, configuration order, selected-child workspaces, branch-only and mixed branch/worktree targets, missing-branch inventory, `--force`, `--keep-branches`, and dry-run pending-operation envelopes. Protects primary/locked/stale/caller-containing worktrees and unmanaged nested Git repositories. Actual removal requires `--force`; this authorizes discarding dirty target content. Hook execution, path targeting, keep-worktrees/detach, no-check-dirty and interactive confirmation remain unsupported.

- **Standalone mutation:** Existing zero-config init/create/remove subset remains available, including ignore safety, local/remote-tracking branch reuse, create dry-run and keep-branches removal. This has separate eligibility and mutation rules from ordinary list.

- **Status:** Configured parent/child and standalone JSON, default/short/verbose human output in captured-process fixtures, configuration order and only/group filters. Missing-child rows remain in JSON/verbose output with exit 1 and are hidden in default/short output. Local filesystem `origin` remotes support upstream/default and configured base comparisons, repository-over-workspace precedence, logical `origin/` normalization, ahead/behind drift, detached HEAD and duplicate comparison targets. Missing remote refs and local transport failures produce source-identical comparison/refresh warnings. All selected remote policies are preflighted before fetch. Non-bare configured linked checkouts use their active config root; child-only linked trees retain the ancestor configuration root. Network, non-origin/multiple remotes and non-origin branch-tracking policies remain unsupported. Bare projection, TTY spinner behavior, broader repository failure and human usage-error parity remain unclaimed.

- **Doctor:** Read-only local configured primary/child and standalone diagnostics, with configuration-order repository findings, missing/broken/dirty/detached/no-upstream observations, local default-branch behind findings, local unborn/orphan HEAD diagnostics, configured-base unavailable findings without remotes (workspace/meta/child precedence), effective directory-ignore inspection, stale owned ignore rules and stale Git worktree records. Standalone checks the main repository only. Supported fixtures match complete JSON, exit/stderr and uncolored human output, including ordinary/outside errors. No fetch, ref updates, hooks, ignore application or pruning; Git status disables optional locks and fsmonitor hooks. Indexed gitlink/submodule topology (including uninitialized gitlinks) is explicitly rejected before any repository status observation, using NUL-delimited index metadata rather than `.gitmodules`. Top-level clean/process filters and unreadable index topology also fail closed. Remote-backed/tracking policies, active workspace/child/user-global hooks or inline scripts, nonempty materialization, stored ignore preferences, external/symlinked paths and configured linked/bare topology fail explicitly. Malformed-config and phase I/O error wording remains native; failed phases retain other findings. Standalone worktree-discovery failures are reported explicitly, unlike the source’s empty failure result. Colored terminal rendering and broader topology/error parity remain unclaimed.

- **Prune/install:** Existing standalone/configured metadata prune with dry-run and `--expire now`; informational direct-binary install contract. Other prune policies/topologies remain unsupported.

Create uses discovery order; status and removal retain configuration order. Status and create have different selection error contracts. No configured defaults are silently applied as successful launch/hook behavior: explicit create overrides are required for this subset.

## Mutation safety and remaining parity work

Plans check Git identity, branch/ref state, destinations, config and effective ignore policy before execution. Coordinated create records newly created branches before adding worktrees. Rollback removes worktrees through Git, preserves pre-existing branches, checks ownership before cleanup, and reports cleanup failures. File rollback preserves files changed after the transaction wrote them. Directory cleanup is limited to owned empty directories; production Rust does not recursively delete Git repositories.

This is not full failure parity. Coordinated mid-execution failures return nonzero alpha envelopes containing completed operations and rollback errors, rather than the complete source recovery contract. Concurrent external Git changes in the final validation-to-mutation window, partial filesystem writes, and complex mixed repository failures need more characterization. Hook/materialization rollback, configuration migrations, Unicode collision rules, stale ignore reconciliation, external/symlinked paths and bare/linked mutation topology remain blocking work.

Still unported: add/clone/delete, exec/setup, pull/push/sync, move/handoff, switch and terminal/editor integration, shell integration, completion/query, configure, update/uninstall and native distribution integration. Human init/create/remove text is not source-identical; status parity is bounded to the captured-process cases above. Full parser/help/error precedence is not claimed. Hook policies and materialization require their real lifecycle, provenance, input, timeout and recovery contracts; empty success results are not substitutes.

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

Use `.exe` on Windows. Source comparisons require installed Node/Bun project dependencies. The native-only journey requires Node and Git, but no TypeScript dependencies. `ARASHI_TS_SOURCE` can select an independent source entrypoint. The characterization mode additionally requires supported local doctor parity in ordinary, configured parent/child and outside contexts. It exits zero when all comparisons match; any difference fails the run.

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

Doctor slice, macOS, 2026-09-05, with `CARGO_HOME="$PWD/target/cargo-home"` and existing locked dependencies:

- New doctor black-box tests were executed before implementation: **0 passed, 6 failed** (`target/doctor-red.log`). Further regressions caught directory-versus-probe ignore inspection and contained absolute child paths before their fixes.
- `cargo fmt --check`, clippy with `-D warnings`, and locked release build: exit 0. Full Rust tests with `ARASHI_TS_PARITY=1` and `--include-ignored`: **101 passed, 0 failed, 0 ignored**, including **13 doctor tests** (`target/rust-doctor-all-tests.log`). External source parity: **15/15** (`target/source-parity.json`); characterization: **19/19**, exit 0 (`target/characterization.json`).
- Doctor tests snapshot fixture files (including index, refs, registrations, config and ignores) and isolated home contents; source doctor runs only in disposable fixtures. Malformed-config, phase-I/O and unsupported-policy tests assert native safety contracts rather than source equality.
- This doctor slice leaves TypeScript production/helpers and npm/install/release contracts untouched; the full TypeScript suite is outside its scope. Doctor topology checks reuse `paths::same_existing` from the concurrent Windows fix; that fix’s implementation and tests remain separately owned.

Windows path handling and the configured release journey passed alongside Linux/macOS and source parity at `0d5671e` ([CI](https://github.com/corwinm/arashi/actions/runs/33951722809)). Doctor changes require their own exact-head CI. Downstream arashi-docs/arashi-skills need this bounded scope documented before publication; stable npm/shell distribution remains unchanged.

## Continuation slices (2026-09-05)

Inherited doctor/filter edits were preserved and formatted before implementation. Initial full locked tests passed (102 tests, including 14 doctor tests), as did clippy, release build, source parity (15/15) and characterization (19/19); evidence is in `target/port-initial-*` and `target/port-clippy.log`.

Status base/warning, human-output and non-bare linked-root slices and configured branch-only removal were driven by failing native process tests before implementation. `tests/rust_parity.rs` compares retained source and native complete envelopes, exits, stderr, human bytes and fixture effects. New remote fixtures use filesystem remotes only. Branch-only deletion captures and revalidates branch OIDs, retains protected-worktree checks, and reports null-worktree hook targets only after the existing absence preflight. Mid-operation failure envelopes and the final validation/deletion race remain incomplete.

The detailed acceptance checklist, including every previously listed gap, is `target/port-completion-checklist.md`. Stable distribution, TypeScript production/helpers, signing and installation setup are unchanged. Downstream docs/skills still require updates before publication; they were reviewed for relevance but not edited outside this worktree.

Final continuation validation: **109 passed, 0 failed, 0 ignored** with `ARASHI_TS_PARITY=1`, locked all-target tests and `--include-ignored` (`target/continuation-tests.log`). Formatting, clippy `-D warnings`, release build and the sequential validation script exited 0. Native release smoke **12/12**, source release parity **15/15**, characterization **19/19**: `target/continuation-{smoke,parity,characterization}.json`. Supporting fmt/clippy/build logs and the reproducible script are `target/continuation-*.log` and `target/validate-port-continuation.sh`. These checks do not close the unchecked ledger gaps or replace parent-owned exact-head cross-platform CI. Retained TS production and helper/distribution paths were not changed, so the full retained TS suite was not rerun.

## Doctor review follow-up (2026-09-05)

Independently reproduced review P1 in disposable local Git fixtures: direct standalone and nested configured-child submodules executed local clean/process filters during native doctor. All four new sentinel regressions failed before the fix; the clean cases returned `ok: true` while creating markers (`target/doctor-submodule-red.log`). Ordinary recursive Git status controls establish that both filter types really execute. After the fix, all four pass with absent markers and unchanged fixture/home snapshots (`target/doctor-submodule-green.log`). Doctor now rejects indexed gitlinks across all configured targets before observations; it does not suppress submodule dirtiness. This is topology rejection, not recursive submodule support. Additional tests cover gitlinks without `.gitmodules`, uninitialized gitlinks, unusual index path delimiters and invalid index preflight.

P1-only validation completed with exit 0: offline locked source/native all-target suite **113 passed, 0 failed, 0 ignored**, fmt, clippy, release build, native smoke **12/12**, external source parity **15/15**, and characterization **19/19**. Logs/reports: `target/doctor-submodule-{tests,fmt,clippy,build,smoke,parity,characterization}.*`; script: `target/validate-doctor-submodule.sh`.

Follow-on implementation covers configured-base findings when no remote exists and local unborn/orphan HEAD diagnostics. Each was driven by a failing native regression (`target/doctor-base-red.log`, `target/doctor-unborn-red.log`), then compared against complete retained-source JSON, human bytes, exits/stderr and fixture snapshots (`target/doctor-base-green.log`, `target/doctor-unborn-green.log`). A configured base remains unavailable without a remote even when a local branch exists, matching the source. Review also verified and fixed repeated `origin/` normalization through the source resolver layers (`target/doctor-base-prefix-{red,green}.log`). Unborn findings retain the source's porcelain branch label. Remote-backed policies and broader malformed-HEAD/error behavior remain unclaimed.

All inherited uncommitted changes were retained. No TypeScript production/helpers, stable distribution, signing/install setup, other worktrees, commits or remote writes were changed. Downstream docs/skills require the new supported scope and explicit submodule rejection documented before publication; those parent-owned repositories were not modified. Exact-head cross-platform CI and independent review remain parent-owned. Full Rust port completion is not established; unchecked acceptance items remain open.

Final review-follow-up validation: **118 passed, 0 failed, 0 ignored**, including **23 doctor tests**, with `CARGO_HOME="$PWD/target/cargo-home" ARASHI_TS_PARITY=1 cargo test --offline --locked --all-targets -- --include-ignored --test-threads=4`. Fmt, offline locked all-target clippy with `-D warnings`, offline locked release build and the sequential validation script exited 0. Release native smoke **12/12**, external source parity **15/15**, characterization **19/19**. Reproduce with `target/validate-doctor-review-final.sh`; actual test/build/check logs and raw comparison reports are `target/doctor-review-final-*`. The full retained TypeScript suite was not rerun because its production/helper/distribution paths were unchanged. These local results do not close the remaining port checklist or replace parent-owned independent review/exact-head CI.
