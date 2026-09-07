# Rust alpha completion ledger

State reconciled against `f9b9df2a95514b8ea9667e407f18793d026902be`. This is an evidence ledger for the controlled local alpha, not a whole-port completion score.

## Integrated and locally supported

- [x] Canonical `aw`/`arashi` alpha identity and private `.arashi-alpha` installation are integrated (`ca8eee8`, `981ecf8`, `f9b9df2`).
- [x] Install/refresh requires explicit canonical-shadow consent and does not edit PATH, profiles, registry state, stable bytes, npm state, or publication channels.
- [x] Native setup owns only the two canonical binaries and its closed manifest; malformed, modified, linked, extra, stale-lock, wrong-platform, and retired schema-1 `aw2`/`arashi2` destinations fail closed.
- [x] Canonical shell/completion output and private-PATH resolution are covered; stable `update`/`uninstall` dispatch is blocked.
- [x] Local macOS artifact lifecycle covers packaging, native extraction, install, refresh, refusal, failed-promotion rollback, uninstall, stable-state preservation, and reproducibility.
- [x] Integrated macOS PTY/process cleanup corrections are represented by `5797f07`, `3ff1d1f`, `839bf54`, and `0511415`; their focused local validation passed before integration.
- [x] Canonical Windows PowerShell/cmd PATH assertions and lifecycle test coverage are implemented in `981ecf8`.

## Open alpha handoff gates

- [ ] Integrate the reviewed Windows process/authentication cleanup lane at `cf811ae70792b1c70631e7c8dcd21107255298ac`; it is not an ancestor of this head.
- [ ] On the resulting exact head, run formatting, locked all-target Clippy/tests (including source oracles), release build, external parity/characterization/native smoke, and the complete Rust alpha workflow matrix. Platform-conditioned skips remain noncoverage.
- [ ] Retain the exact candidate artifacts and checksums from that head; install those bytes into a disposable/private tester home on every supported OS.
- [ ] Dogfood representative workflows that are marked supported in `docs/rust-port.md`, verifying `aw` resolves inside `.arashi-alpha` and reports the controlled alpha identity.
- [ ] Refresh from the exact artifact, exercise failure rollback, uninstall, remove the temporary PATH shadow, and verify the unchanged stable `aw`/`arashi` installation is exposed again.
- [ ] Push normally, verify the remote SHA, and require exact-SHA Rust and alpha CI success before tester handoff.

## Reconciliation validation

Run locally on macOS against the unchanged implementation at `f9b9df2`:

- `cargo test --locked --test rust_alpha`: 3 passed.
- `python3 -B tests/rust/alpha_packaging.py`: 2 passed.
- Release build of `arashi`, `aw`, and `arashi-alpha-setup`: passed.
- `python3 -B tests/rust/alpha_distribution.py`: 20 passed, 3 native-Windows cases skipped.
- CLI/lifecycle/distribution contract checks, completion generation check, focused documentation formatting, Bash syntax, and `git diff --check`: passed.

## Explicitly not closed

- Public release, npm/stable installer migration, automatic update discovery, broad source parity, all command/policy/topology support, companion-site publication, and whole Rust-port completion remain open.
- No user-home installation, artifact dogfood, rollback to a real stable installation, push, or successor-head CI is claimed by this reconciliation.
