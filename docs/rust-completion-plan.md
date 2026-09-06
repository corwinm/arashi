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
- `v2-move`, `v2-delete`: preserved drafts, queued for independent review and source-completion work.
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

## Model and continuity

User prefers Astra. Parent and first workers were verified as `gpt-6-astra` in live session metadata. Delegation inherits the parent (global model/provider overrides are empty). On detected model reset/unavailability or low ChatGPT usage, pause and notify Corwin; never silently substitute a coding model. Keep ownership, heads, evidence and unresolved gates here so a resumed session does not repeat the earlier recovery loop.
