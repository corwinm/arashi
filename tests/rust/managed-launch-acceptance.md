# Managed adapters: retained-source implementation acceptance

Oracle: `07c77e0fa4b79ec3d2902ad5aecca05ad16a52ae`. Parent resolved the earlier scope discrepancy in `managed-launch-provenance.md` in favor of this actual source, not richer initial prose. Dependency `2c2ba6ca6e6ab4f98d63c1ca6b25f5a26ebb8df3` was merged normally with `--no-ff` as `9ed8bfaa06ee40841b669aee07c284c20ee3ce5a`, preserving characterization commit `0673c55`.

Pinned source blobs, verified against the oracle and current retained files:

- `src/lib/switch-launcher.ts`: `1d4eb705f8c6b648ccef512ea767834efa03bd38`
- `src/lib/kitty-launcher.ts`: `157f4d1e11f3479662444d773cff392991404a77`

## Implemented scope

- tmux: `new-window -c <path>` for both dispositions; active TMUX required; no discovery/reuse or fallback.
- sesh: active TMUX and available sesh required; delegates quoted `sesh connect` inside a tmux new window. No session internals invented.
- Herdr: ordered `worktree open` and targeted `tab create`, validated structured identities. The caller must supply the Git-resolved non-bare `LaunchTarget.herdr_source` for window mode; absent source fails before vendor mutation.
- cmux: ordered `workspace create --cwd ... --focus true --json` for both dispositions; validates workspace_ref/workspace_id; no discovery/reuse or fallback.
- Kitty: canonical-path SHA-256 identity, inherited-PATH/bundle kitten lookup and version preflight, source-compatible directory/owner/recovery locking, strict structured state projection, exact marker focus, one reconciliation, and session-backed `--type=tab` launch for both dispositions with ID/session/focus readback. Transport is exclusively the external kitten CLI; no native DCS/TCP/socket implementation.

Public entry points are `managed_launch::execute(&ManagedPlan, &LaunchTarget, &LaunchContext)` and injectable `execute_with(..., Option<&Path> /* lock root */, &mut runner)`. The production entry uses the committed launch-only native process lifecycle. Errors preserve foundation error categories; exact TypeScript error prose is not claimed.

## Verification performed on macOS

Strict RED/GREEN observed: four non-Kitty family groups failed against the adapter stub, five Kitty protocol groups failed against the Kitty stub, and ownership tests failed against the lock stub. Additional RED/GREEN caught malformed-owner release handling and non-integer timestamps: owner.createdAt must use integer Date.now-compatible milliseconds, not fractional seconds converted to milliseconds, to preserve equality after JSON readback.

With `CARGO_TARGET_DIR=target/managed-cargo CARGO_BUILD_JOBS=2`:

- `cargo fmt --check`: passed.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `cargo test --locked --test rust_launch --test rust_managed_launch`: foundation 26 passed; managed 18 passed, 3 opt-in driver/native entries ignored.
- Same focused tests with `--release`: same results.
- `cargo build --locked --release`: passed.
- New JavaScript fixture drivers: `node --check` passed.
- Original retained-source subprocess fixture: all 19 passed again.
- `managed-launch-rust.mjs`: the same 19 transcripts passed through real native Rust child execution in debug and release. Parsed reports matched ordered argv, cwd, directive stripping, success/failure and successful outcomes against source, normalizing only disposable root and derived identity. Fixture executables are not vendor applications.
- `managed-launch-lock-interop.mjs`: four actual subprocess scenarios passed in debug and release: source-held lock excludes Rust; Rust-held excludes source; each implementation recovers the other's real exited process. Owner files and complete cleanup read back.
- Installed tmux 3.7c: Rust debug and release private-server acceptance passed. Both dispositions created additional windows (counts 2 then 3), all with the exact quoted cwd. Original source private-tmux acceptance also passed again. Private socket/HOME and `/dev/null` config only; cleanup kills only that server.

Machine-readable local evidence (generated under ignored target/): `managed-source-characterization-resumed.json`, `managed-rust-debug.json`, `managed-rust-release.json`, `managed-parity-comparison.json`.

Reproduction after building the integration test:

```sh
export CARGO_TARGET_DIR=target/managed-cargo CARGO_BUILD_JOBS=2
cargo test --locked --test rust_managed_launch
# Set MANAGED_TEST_BIN to the absolute executable printed by cargo's test build.
MANAGED_TEST_BIN=/absolute/test-executable node tests/rust/managed-launch-rust.mjs target/managed-rust.json
MANAGED_TEST_BIN=/absolute/test-executable node tests/rust/managed-launch-lock-interop.mjs
ARASHI_MANAGED_NATIVE_TMUX=1 cargo test --locked --test rust_managed_launch installed_private_tmux -- --ignored --nocapture
```

## Explicit remaining gates

These new modules are compiled/exercised by path-included integration tests. Per lane ownership, no launch/CLI/lib/Cargo edits were made. Parent must register `pub mod managed_launch`, wire consumers, resolve Herdr source candidates, and review the result. The release CLI is **not** claimed to expose these adapters before that integration.

Read-only installed probes: sesh 2.28.0, Herdr 0.7.4, bundled kitten 0.48.2. cmux absent from inherited PATH. No real sesh connect, Herdr GUI/socket, Kitty GUI/socket, or cmux vendor acceptance is claimed. No user's terminal UI was mutated. Windows code/test preparation exists, but no native Windows execution or remote-host use occurred; that remains the parent's reserved gate. No main integration approval, push, PR, release, or runtime TypeScript/Python fallback.
