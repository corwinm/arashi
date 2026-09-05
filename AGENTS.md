# Arashi CLI Agent Rules

This repository contains the Arashi CLI implementation.

## Scope

- Put CLI source changes in `src/`.
- Put tests in `tests/`.
- Keep CLI-specific docs in this repo's `README.md` or `docs/`.

## Working Rules

- Keep changes minimal and command-accurate.
- On `v2`, implement native Rust in `src/rust/` and behavioral tests in `tests/rust*.rs` and `tests/rust/`. Keep the retained TypeScript source/tests as the parity oracle, not a runtime fallback.
- Read `docs/rust-port.md` for supported behavior and remaining work. Unsupported policies must fail before mutation; help registration is not implementation.
- Preserve npm/shell installation contracts and do not switch stable publication to an incomplete port.
- If command behavior, configuration, hooks, or user workflow changes, review whether `repos/arashi-docs/` and `repos/arashi-skills/` also need updates.

## Validation

- `cargo fmt --check`
- `cargo clippy --locked --all-targets -- -D warnings`
- `ARASHI_TS_PARITY=1 cargo test --locked --all-targets -- --include-ignored`
- `cargo build --locked --release`
- `node tests/rust/parity.mjs target/release/arashi target/source-parity.json` (use `.exe` on Windows)

Retained TypeScript checks (run when their source or distribution paths change):

- `pnpm run lint`
- `pnpm run test`
- `pnpm run build`
