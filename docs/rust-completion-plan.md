# Rust replacement completion plan

> **For Hermes:** Use subagent-driven-development for isolated implementation and independent contract/quality review. Keep this file current at integration milestones.

**Goal:** Replace the retained v1 CLI with a native Rust implementation that supports its real workflows, without a TypeScript runtime fallback or disruption to stable v1 installations.

**Architecture:** Keep native modules in `src/rust/`, retained TypeScript as the behavioral oracle, and real Git subprocesses for Git transport and repository operations. Prefer shared, source-compatible contracts over accumulating inconsistent command-specific rejection policies. Preserve ownership-aware recovery without inventing new adversarial requirements beyond the source's accepted safety boundary.

**Tech stack:** Rust, Git, source-enabled Cargo process tests, retained Node/Bun integration tests, Bash/PowerShell distribution, native Linux/macOS/Windows CI.

## Baseline and preservation

- Known-good delivered baseline: `ce7801727c75dac0e38c6f7442158c297085e82c` on `v2` (native three-platform and source-parity CI passed).
- Recovery snapshot: `/Users/corwin/Developer/arashi-arashi/.arashi/recovery/astra-takeover-20260905-220453/manifest.json`; draft archives and verified Git bundle beside it. Original drafts remain in their worktrees until explicitly integrated/retired.
- This plan supersedes ignored `target/port-completion-checklist.md` as the delivery queue. `docs/rust-port.md` remains the current support ledger, not a full-port completion claim.
- Stable npm, v1 installer endpoints, and v1 binaries are not switched during port development.

## Completion contract

Every public command below must be implemented against the retained source, including defaults, JSON/human/errors, selection, ordinary network remotes, configured primary and linked workspaces, supported standalone/bare topology, lifecycle/materialization, and actual supported platform integrations where applicable. Registration/help and one successful fixture do not close a command. Explicitly document intentional deviations and seek user approval for a reduction in v1 behavior rather than silently declaring completion.

A normal user must be able to install alongside v1; initialize a configured workspace; add/clone ordinary authenticated remotes; create from configured bases/defaults; switch and work using shell/editor integration; inspect and hand off status; move changes; pull/push/sync; remove/delete/prune; configure policies; and upgrade/remove the native installation without damaging v1 or unowned files.

## Worktree ownership and first recovery wave

Parent alone owns integration `v2`, the tracked plan and final review/CI/push. Workers commit locally; no force pushes, amendments, resets, or concurrent writes to another lane.

- `v2-switch`: switch repairs and shared config/default reconciliation with the read-only `v2-configure-json` draft. Include configure inspection; editing/interactive configure remains follow-on.
- `v2-sync-local`: diagnose actual timeout/recovery failures and produce verified native sync.
- `v2-shell`: recover shell and committed handoff; integrate current completion baseline in this lane.
- `v2-add`: recover add, integrate clone baseline, support ordinary noninteractive network add/clone.
- `v2-pull-push`: recover pull/push, implement ordinary Git transports and preserve source failure/selection semantics.
- `v2-alpha-distribution`: side-by-side `aw2` packaging/install lifecycle; never stable publication.
- `v2-move`, `v2-delete`: recover/review inherited drafts against source change-transfer and repository-deletion behavior.
- `v2-parser`: native parser/help compatibility in a separate module; integrate after command-family dispatch changes.
- Read-only contract audit: `/tmp/arashi-v2-completion-matrix.md` (pending); promote relevant requirements here after source verification.

## Milestones (not interchangeable with full completion)

1. **Recover and integrate existing work.** Checkpoint drafts, resolve concrete failures and shared config changes, verify focused source tests, contract review, quality review, then merge and exact-head CI. Do not discard inherited tests to make a green subset.
2. **Complete ordinary configured workflows.** Network Git, normal command defaults, setup, human/JSON/errors and noninteractive operation compose in one real workspace. Shared-policy integration tests are required.
3. **Close retained compatibility.** Interactive selection/confirmation/onboarding/configure; terminal/editor launch; linked/bare/standalone projection; hook/materialization consumers; ignore migration/path policy; recovery/error contracts; all public options below.
4. **Deliver native lifecycle.** Side-by-side alpha Bash/PowerShell install, real archives, checksums, refresh/update/uninstall and v1 upgrade safety. Tests use disposable homes; no user-home installation or release publication until acceptance.
5. **Replacement acceptance.** Three-platform native CI, all source oracles, selected retained process suites expanded to all applicable CLI behavior, real CLI journey, docs/skills/extension compatibility review, and clean integrated remote head. Publish only after actual release readiness; a successful alpha workflow is not full port completion.

## Public command acceptance inventory

Generated initially from retained `contracts/cli-commands.json`; checkboxes require behavioral evidence, not source-string tests.

- [ ] `add`: --create-setup, --force, --json, --name. Full behavior acceptance pending.
- [ ] `clone`: --all, --base, --repo-base, --json. Full behavior acceptance pending.
- [ ] `completion`: (no public options beyond help). Full behavior acceptance pending.
- [ ] `configure`: --json. Full behavior acceptance pending.
- [ ] `create`: --base, --conflict, --herdr, --launch, --move-changes, --no-hook-input, --no-hooks, --no-launch, --no-progress, --no-switch, --repo-base, --sesh, --switch, --tab, --tmux, --group, --interactive, --json, --dry-run, --only. Full behavior acceptance pending.
- [ ] `delete`: --force, --json, --dry-run. Full behavior acceptance pending.
- [ ] `doctor`: --json. Full behavior acceptance pending.
- [ ] `exec`: --dirty, --fail-fast, --jobs, --group, --json, --only. Full behavior acceptance pending.
- [ ] `handoff`: --link, --next-command, --risk, --todo, --validation, --json. Full behavior acceptance pending.
- [ ] `init`: --ignore-scope, --no-discover, --repos-dir, --worktrees-dir, --zero-config, --force, --json, --dry-run, --verbose. Full behavior acceptance pending.
- [ ] `install`: --json. Full behavior acceptance pending.
- [ ] `list`: --max-depth, --json, --table, --verbose. Full behavior acceptance pending.
- [ ] `move`: --from, --to, --json. Full behavior acceptance pending.
- [ ] `prune`: --expire, --json, --dry-run. Full behavior acceptance pending.
- [ ] `pull`: --group, --json, --only, --verbose. Full behavior acceptance pending.
- [ ] `push`: --set-upstream, --group, --json, --dry-run, --only. Full behavior acceptance pending.
- [ ] `remove`: --keep-branches, --keep-worktrees, --no-check-dirty, --no-hook-input, --path, --force, --json, --dry-run. Full behavior acceptance pending.
- [ ] `setup`: --group, --json, --only, --verbose. Full behavior acceptance pending.
- [ ] `shell`: (no public options beyond help). Full behavior acceptance pending.
- [ ] `shell init`: --json. Full behavior acceptance pending.
- [ ] `shell install`: (no public options beyond help). Full behavior acceptance pending.
- [ ] `shell uninstall`: --dry-run, --yes. Full behavior acceptance pending.
- [ ] `status`: --group, --json, --only, --short, --verbose. Full behavior acceptance pending.
- [ ] `switch`: --all, --cd, --cursor, --herdr, --ignore-configured-launcher, --kiro, --launch, --path, --repos, --sesh, --tab, --tmux, --vscode, --json. Full behavior acceptance pending.
- [ ] `sync`: --group, --json, --only, --verbose. Full behavior acceptance pending.
- [ ] `uninstall`: --dry-run, --yes. Full behavior acceptance pending.
- [ ] `update`: --check, --json, --dry-run, --yes. Full behavior acceptance pending.

## Per-slice execution and gates

1. Read affected retained command, helpers/contracts and native consumers. Name the exact supported workflow and existing source tests.
2. Reproduce behavior in disposable repositories. For a behavior fix/addition, add/run a focused regression that fails for the missing behavior before production edits.
3. Implement minimal native behavior, including recovery and failure reporting. Preserve caller files/refs; no TS fallback.
4. Run source-enabled focused tests, `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, and diff checks. Tests use bounded execution and clean up owned children. One suite per worktree; never overlap repeated full suites.
5. Independent spec/behavior review, then code-quality review, scoped to an exact commit. Fix concrete blockers; defer optional redesign rather than restarting a broad review loop.
6. Parent merges into `v2`, resolves shared behavior (not merely conflict markers), runs integrated checks, pushes normally and verifies exact remote SHA and CI before calling the milestone delivered.
7. Update support ledger and acceptance evidence. Continue the next unmet real workflow. A draft, a local commit, a passing test subset and a delivered feature are different states.

## First local recovery integration milestone

- Integrated `v2-switch` at `253da82420f673e2f25a89232006d03f8940dac1` into `v2` with merge `05ab5af8faf59a1dd4ab992207e2ce209aad06de` (first parent `d5ebd026fe6cb8e271d550f1f6811f07395f53bc`). This is local integration, not independently approved or remote-CI-delivered behavior.
- Scope: shared create/editor/switch legacy-default normalization, sanitized read-only `configure --json`, and bounded noninteractive switch selection/parent-shell directives. Interactive configure/selection and terminal/editor launch remain unsupported; no public-command acceptance checkbox is closed.
- The sole textual conflict was the support ledger's remaining-work paragraph. Resolution retains delivered clone/completion scope and the new switch/configure subset. No new behavioral regression was observed in integration. Existing completion-plan edits (move/delete recovery and parser queue) were preserved; original bytes and diff are backed up under `target/integration-switch/inherited-plan.*`.
- Local macOS checks use only this checkout's `CARGO_HOME="$PWD/target/cargo-home"` and `CARGO_TARGET_DIR="$PWD/target"`. Source-enabled locked/offline all-target tests with `--include-ignored --test-threads=4`: **277 passed, 0 failed, 0 ignored**. Config/configure/switch focused tests: **35/35** each in debug and release. Fmt, locked/offline all-target clippy `-D warnings`, locked/offline release build and diff whitespace checks passed. External release source parity: **15/15**.
- Evidence: `target/integration-switch/{focused,all-tests,release-focused,fmt,clippy,build,source-parity}.log`, raw `source-parity.json`, and programmatically aggregated `test-counts.json`. The recovered switch lane's earlier timed-out all-target run remains a non-pass; the complete integration run above supersedes that gate locally.
- Parent-owned next gates: independent spec/behavior review, then quality review of cumulative `d5ebd02..05ab5af`; exact-head Linux/macOS/Windows/source CI before delivery. No push, PR, publication, stable npm/installer changes or Python prerequisite was introduced.
- Next integration slice: recovered `v2-shell` at `fba5733` (shell wrapper plus handoff), to compose the now-integrated directive producer with its native wrapper consumer. Reconcile shared CLI dispatch/rendering and test an actual wrapper-driven switch in a disposable shell/home. Defer `v2-parser` until command-family dispatch integration; alpha distribution retains pending native Windows acceptance.

## Shell/handoff local integration milestone

- Starting clean head: `95bc0f2100d69c20872a8bf12680b6875e20e296`. Merged recovered `v2-shell` at `fba5733` with local merge `3b0f4279dafb74350d316a23005a26c74e5c1ea6`. Both shell/handoff and switch/configure dispatch/module registrations are retained; the support ledger conflict preserves all existing bounded scopes and outstanding launcher/editing gaps.
- Added actual generated-wrapper journeys for Bash, Zsh and Fish, using both native and retained-source binaries in disposable homes. `arashi switch` enters a configured linked checkout; `aw switch --cd --path` returns to the primary; failed selection preserves cwd and status; quoted/spaced/dollar/backslash paths work; temporary directives and exported directive state do not leak. Existing installed Zsh startup/completion acceptance also remains green. These are passing composition tests, not a claimed new production RED/GREEN repair.
- Corrected inherited test platform scope: shell mutation-success fixtures no longer assert success on Windows, where install/uninstall deliberately reject. Platform-independent init checks and the dedicated Windows rejection test remain. This is fixture eligibility repair, not native Windows execution evidence. The Fish journey explicitly reports noncoverage when Fish is absent; this host exercised Fish 4.8.1.
- Local macOS source-enabled locked/offline all-target/include-ignored suite: **306 passed, 0 failed, 0 ignored**. Final shell/handoff/switch/configure focused suites: **50/50** each in debug and release. Fmt, locked/offline all-target clippy with `-D warnings`, release build and diff whitespace checks passed. Windows-only fixture eligibility annotations were added while the all-target run was underway; final debug/release focused tests and repeated fmt/clippy passed afterward, with unchanged macOS test eligibility.
- External release source parity: **15/15**; characterization: **19/19**; native smoke: **12/12**. Retained source shell units: **52/52**. The five selected retained standalone lifecycle/init cases pass against both source and release-native binary, with 69 lifecycle and 18 init cases deselected per implementation; this is not full retained-suite coverage.
- Evidence: `target/integration-shell/validate.mjs`, `validation-results.json`, `retained-validation-results.json`, `test-counts.json`, `all-tests.log`, `release-focused.log`, `final-{fmt,clippy,focused}.log`, raw parity/characterization/smoke JSON and retained logs. Initial Vitest substring filters additionally found archived baseline tests under `target/`; those unscoped logs are preserved separately and superseded by successful runs with `--exclude 'target/**'`. Counts above refer only to current-checkout retained tests.
- No production integration regression was observed. Stable v1 publication, npm metadata/entrypoints, installer/release contracts, retained TS production/helpers, signing and other lanes are unchanged. Native runtime adds no Python prerequisite. Companion arashi-docs/arashi-skills need bounded Rust scope updates before publication and were not modified.
- Parent gates: independent repository-aware behavior/quality review of exact cumulative `95bc0f2..3b0f427`, followed by exact-head Linux/macOS/Windows/source CI before delivery. No push, PR or publication occurred; no public-command completion checkbox is closed. Known retained Bash 3.2 activation/completion gap and native Windows shell mutation rejection remain explicitly documented.
- Next coherent integration candidate: recovered sync-local, composing switch/status/handoff with actual configured synchronization; confirm its exact committed head and focused evidence before merging. Keep parser integration after remaining command-family dispatch work; terminal/editor launchers, interactive configure and side-by-side distribution acceptance remain separate milestones.

## Sync local integration milestone

- Started at clean `c12f2e521601430d18f16fd1bf0da714125d150d`. Verified recovered `v2-sync-local` was still clean at `49b79eb9f1f66e8adc65dcbf6b0b09c9f842d12d`, including its actual retained-source focused pass and rollback-stall RED/GREEN logs. Integrated it with local merge `ee1373a174a791d6550dbb322919cb97f906f416`; preserved both switch/sync module registrations and every existing ledger scope. The original lane's timed-out full run remains a non-pass, not silently promoted to acceptance.
- Added a real source/native composition test in `tests/rust_sync.rs`: generated Bash wrapper, configure inspection, sync across existing/new child branches, status/handoff, child repository switch, primary return and repeat sync. It checks config preservation, parent/child OIDs, branch alignment without upstreams and temporary-directive cleanup. Initial fixture failures used an invalid legacy `launchMode=cd` and assumed JSON map insertion order; fixing the fixture required no production behavior change and is not production RED/GREEN evidence.
- The first integrated all-target run found two genuine shared-process regressions: lifecycle direct interruption created a late marker, and lifecycle timeout left a descendant alive. The direct-interrupt failure reproduced alone. Fix `346a04e736c2357d2267f73f2b25c759519b8714` separates sync's birth-checked settlement from the existing lifecycle signaler/runner, which are restored verbatim from `c12f2e5`. No test was removed, relaxed or given a longer deadline. Source-enabled focused GREEN: lifecycle **21/21**, sync **31/31**, including stalled recovery checkout/delete, actual timeout mutation, descendant settlement and external-state preservation. The switch/configure review-blocker source and test paths are byte-unchanged.
- Final local macOS validation at code head `346a04e`: source-enabled locked/offline all-target/include-ignored suite **342 passed, 0 failed, 0 ignored**; release sync/switch/shell/handoff/configure **86/86**; release lifecycle **21/21**. Fmt, locked/offline all-target clippy `-D warnings`, locked/offline release build and diff whitespace checks pass. External release source parity **15/15**, characterization **19/19**, native smoke **12/12**. This is local integration acceptance, not independent approval or exact-head remote CI.
- Evidence is under `target/integration-sync/`: bounded sequential `validate.py`, `validation-results.json`, `test-counts.json`, `code-identity.json`, all-target and release logs, raw external reports, focused composition RED/GREEN, and `initial-failed/` preserving the failed first integration run. Only lane-local `CARGO_HOME=$PWD/target/cargo-home` and `CARGO_TARGET_DIR=$PWD/target` were used. The new locked rustix dependencies were initially missing from this lane's offline cache; `cargo fetch --locked` populated that local cache, then all gates ran offline. Python is only the development validation driver, not a native/runtime/alpha installation prerequisite.
- No pushes, PRs, publication, stable npm/installer edits, retained TypeScript production/helper edits, signing changes or other-lane writes occurred. Companion documentation still needs bounded Rust-scope updates before publication; no command-completion checkbox is closed.
- Parent gates: independently review cumulative `c12f2e5..346a04e`, especially the sync process runner/recovery contracts and lifecycle separation, then run exact-head Linux/macOS/Windows/source CI. Sync still excludes remotes, hooks/materialization, linked/bare/external topology and Windows; Git observations/process inspection are not end-to-end deadline bounded. Next coherent implementation candidate is recovered add/clone for ordinary configured network remotes, after verifying its current head/evidence; parser remains after command-family dispatch integration. Native Node distribution and Bash/PowerShell lifecycle acceptance remain separate, without a Python prerequisite.

## Add/clone network local integration milestone

- Started at clean `63e1d705a8174d404abf5b4dff5c5a0c547bd14c`. Verified recovered `v2-add` remained clean at `78d647926de19b2a0ef0fd711e53cf092f8abee9`; read its actual network/options/drive-path/setup-symlink RED evidence and focused source-enabled GREEN (19 add, 13 clone). Integrated with local merge `ae78407647fc54e33e6dc7657bfd3d2417624cd0`. Cargo test registrations, CLI dispatch/human renderers and the support ledger retain both families; no prior scope was overwritten.
- A source/native configured composition regression failed on native add because it rejected existing canonical switch defaults and sync timeout settings. Fix `19a19ffecb791cabcbaf3a4a16f59f7d8f9889f3` accepts/preserves those canonical settings without activating them; alias-bearing policies that require normalization remain rejected. A separate source oracle compares complete add JSON, stderr and persisted config/ignore bytes with switch `mode=cd` and sync timeout. Source/native journeys exercise actual local-file and loopback Git transfer, add, configure inspection, clone/repeat-clone, branch/OID/URL/config preservation and generated Bash-wrapper switches.
- Remote-backed sync remains unsupported and is tested as nonmutating rejection. The journey explicitly removes both the disposable origin and configured `gitUrl` before local sync/repeat-sync, status/handoff and child/primary shell switches. The first post-fix run still retained `gitUrl` after removing origin and correctly rejected sync; the fixture was corrected, not the sync policy. This is not seamless remote-backed end-to-end acceptance. HTTPS/SSH/SCP inputs in retained network oracles use Git `insteadOf` rewrites to the loopback daemon: actual TLS/SSH/authentication-provider handshakes remain untested.
- Final local macOS source-enabled locked/offline all-target/include-ignored suite: **364 passed, 0 failed, 0 ignored**. Release add/clone/config/configure/sync/switch/shell/handoff: **131/131**; release lifecycle: **21/21**. Fmt, locked/offline all-target clippy `-D warnings`, locked/offline release build and whitespace checks passed. External release source parity **15/15**, characterization **19/19**, native smoke **12/12**. Only lane-local `CARGO_HOME=$PWD/target/cargo-home` and `CARGO_TARGET_DIR=$PWD/target` were used, with one sequential validation driver and no overlapping full suites.
- Evidence: `target/integration-add/{validate.py,validation-results.json,test-counts.json,external-counts.json,code-identity.json,preservation.json}`, focused RED/GREEN logs, all-target/release logs and raw external JSON. Code was unchanged throughout the final validation; the later tracked milestone entry is documentation-only. Switch/configure/config source and tests, sync source/tests, lifecycle tests and all of `process.rs` are byte-identical to starting `63e1d7`, preserving lifecycle separation fix `346a04e`.
- No pushes, PRs, publication, stable v1/npm/installer changes, retained TypeScript production/helper edits, signing changes or other-lane writes occurred. Native Node distribution and Bash/PowerShell installers remain retained with no Python prerequisite. Companion Rust-scope documentation, full port acceptance and native Windows acceptance remain pending; no public-command checkbox is closed.
- Parent gates: independent behavior/quality review of cumulative `63e1d7..19a19ff`, then exact-head Linux/macOS/Windows/source CI. The concurrent read-only prior-sync review is not add/clone approval. Next coherent integration candidate: recovered `v2-pull-push` (`567643c`, verify current head/evidence before merging) to make the newly cloned ordinary remotes useful without disconnecting them. Broader remote sync, hooks/materialization, aliases/nonminimal add policies and add rollback remain separate gaps; parser stays after command-family integration.

## Model and continuity

User prefers Astra. Parent and first workers were verified as `gpt-6-astra` in live session metadata. Delegation inherits the parent (global model/provider overrides are empty). On detected model reset/unavailability or low ChatGPT usage, pause and notify Corwin; never silently substitute a coding model. Keep ownership, heads, evidence and unresolved gates here so a resumed session does not repeat the earlier recovery loop.
