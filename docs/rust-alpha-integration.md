# Alpha distribution integration acceptance

Merged integrated `v2` at `502721b84c234d6f3bb86b22b0a25f5d258415e7` into the clean alpha lane at `f70d788e8545f435229b06909f39fa7cc11b7d2a`. Work is local to `v2-alpha-distribution`; no integration-branch edits, push, PR or publication.

The merged dependency contract retains Unix `rustix`, all integrated test targets and the native alpha helper dependencies. Canonical dispatch/parser/completion behavior is retained. Alpha now checks the canonical parsed command before stable lifecycle/shell/completion dispatch, closing the `aw2 -- shell init bash` bypass. Parsed help/version keeps alpha identity. The existing native helper's ownership, rollback and adjacent-launcher implementation is unchanged.

## Local evidence

Raw logs and gate exit markers: `target/alpha-integration-evidence/`.

- `red.log`: both new real-binary regressions failed (stable wrapper emission and canonical help identity).
- `green.log`: 2/2 passing; `release-alpha.log`: 2/2 passing.
- `source-integrated-final.log`: **438 passed, 0 failed, 0 ignored**, `ARASHI_TS_PARITY=1 cargo test --locked --offline --all-targets -- --include-ignored --test-threads=1`. Lane-local Cargo home/target. Initial attempt lacked the retained source's `commander` dependency; local `pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts` repaired the developer environment without manifest/lockfile edits.
- Sequential follow-on gates: fmt, all-target clippy with `-D warnings`, release build, release alpha regressions, packaged lifecycle, external release source parity, whitespace check: all exit 0 (`release-gates.txt`).
- `release-lifecycle.log`: **18 passed, 1 native-Windows skip**. Real payload ZIP and mode-preserving tester archive; native extraction, isolated non-ASCII homes, runtime-free launcher environment, install/refresh/remove, frozen legacy-Python-producer migration, malformed/modified/linked ownership refusal, invalid/duplicate payload and failed-smoke handling, promotion rollback, basename launch, reproducibility, stable-file/profile preservation, and packaged parsed-command boundary/identity regression.
- `release-parity.log`: **15/15** retained-source versus release-binary journeys passed.
- Independent read-only integration review: approved, no concrete correctness/security blocker. This is worktree review, not exact-head remote CI/native-platform approval.

Python remains a **developer packaging/test driver**, not an installation, refresh, removal or CLI prerequisite. The tester bundle contains only native payload/helper, checksums and Bash/PowerShell launchers; lifecycle subprocesses run with no interpreter tools on PATH.

## Produced local artifacts

Under `target/alpha-distribution/`:

- `arashi2-2.0.0-alpha.1-macos-arm64.zip`: SHA-256 `7ab87e67dd8d9703f1664bcd0114aa3d0a61d22ccd3d4c1896349bebdf4977ba`
- `arashi2-2.0.0-alpha.1-macos-arm64-tester.tar.gz`: SHA-256 `b1920dc19d89ebd13d271808312a8075b2a921a2ba970fca135697bb8e7190f9`

## Remaining acceptance gaps

Read-only SSH preflight reached `win-test`: Windows `10.0.26200`, PowerShell `5.1.26100.9278`. Cargo/rustc were absent on PATH and at the standard user Cargo paths; Visual Studio installer and PowerShell 7 were absent at their standard paths. No dependencies were installed, artifacts transferred or remote home settings changed. No native Windows build/lifecycle or Windows junction acceptance is claimed. See `windows-preflight.log` and `windows-standard-paths.log`.

Native Linux/other artifact-matrix acceptance, exact-head CI, real stable v1-to-v2 upgrade/Node distribution migration, alpha-specific shell wrappers/completions and wider Rust-port policies remain outside this local acceptance. Stable Node/npm/v1 Bash/PowerShell/publication files remain unchanged. No companion-repository changes are needed for this opt-in local integration; public port-completion guidance must wait for the support-ledger gaps to close. This does **not** complete the Rust port.
