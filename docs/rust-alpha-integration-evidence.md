# Alpha distribution integration evidence

This is a local macOS arm64 distribution milestone, not completion of the Rust port.

## Inputs and composition

- Alpha lane began clean at `f70d788e8545f435229b06909f39fa7cc11b7d2a` on `v2-alpha-distribution`.
- Merged integrated `502721b84c234d6f3bb86b22b0a25f5d258415e7` into that lane, never into or by editing the integration worktree.
- Cargo conflicts retain the native setup dependencies, integrated direct `rustix` dependency, and all integrated test registrations. The lockfile validates offline and locked.
- Native alpha aliases now enter the complete shared parser/dispatcher with an explicit alpha identity. Canonical CLI output and raw completion routing remain unchanged.
- Behavioral RED reproduced `aw2 -- shell init bash` emitting stable wrappers and help losing alpha identity. GREEN guards the parsed command before completion/domain dispatch and preserves alpha help/version identity. Both aliases and extracted release binaries exercise the fix.
- Native helper ownership, rollback and launcher implementations are unchanged from `f70d788`. Stable TypeScript, npm/package lockfile, v1 Bash/PowerShell installers and stable publication are untouched.

## Executed gates

All logs below are lane-local under `target/alpha-integration-evidence/`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused behavioral RED | 2 expected failures | `red.log` |
| Focused GREEN | 2 passed | `green.log` |
| `ARASHI_TS_PARITY=1 cargo test --locked --offline --all-targets -- --include-ignored --test-threads=1` | 438 passed, 0 failed, 0 ignored; 28 executable groups; exit 0 | `source-integrated-final.log`, `source-integrated.exit` |
| `cargo fmt --check` | exit 0 | `fmt.log` |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | exit 0 | `clippy.log` |
| `cargo build --locked --offline --release` | exit 0 | `build.log` |
| `python3 -B tests/rust/alpha_distribution.py` | 18 passed, 1 native-Windows skip | `release-lifecycle.log` |
| `node tests/rust/parity.mjs target/release/arashi target/alpha-integration-evidence/source-parity.json` | 15 comparisons passed | `release-parity.log`, `source-parity.json` |
| Fresh tester packaging and native tar member listing | exact five native-only members | `fresh-package.log`, `fresh-bundle/`, `artifact-sha256.json` |

Cargo used `CARGO_HOME=$PWD/target/cargo-home` and `CARGO_TARGET_DIR=$PWD/target`. Full source and release lifecycle gates ran sequentially, not concurrently. The first source attempt failed because this lane lacked `commander`; a lane-local `corepack pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts` supplied retained-source development dependencies without changing package files. The complete rerun above passed; `source-integrated.log` and `source-dependencies.log` preserve the prerequisite failure and repair.

Lifecycle acceptance uses disposable Unicode homes, actual release ZIP/tester archives, runtime-free setup PATH, frozen historical Python-producer compatibility, missing-helper refusal, manifest/payload/link refusal, failed smoke, real-archive promotion rollback, reproducibility, stable-file/profile preservation and conservative removal. Python remains a maintainer/test dependency, not an install/refresh/remove/runtime prerequisite. A fresh output directory avoids stale loose files from historical packaging attempts; only the exact tester archive is the transport boundary.

Frozen archive SHA-256:

- `arashi2-2.0.0-alpha.1-macos-arm64-tester.tar.gz`: `b1920dc19d89ebd13d271808312a8075b2a921a2ba970fca135697bb8e7190f9`
- `arashi2-2.0.0-alpha.1-macos-arm64.zip`: `7ab87e67dd8d9703f1664bcd0114aa3d0a61d22ccd3d4c1896349bebdf4977ba`

## Native Windows and remaining gates

Read-only, noninteractive SSH to `win-test` succeeded: Windows `10.0.26200`, PowerShell `5.1.26100.9278`. Cargo/rustc were absent from PATH and their standard user `.cargo/bin` locations; standard Visual Studio installer and PowerShell 7 paths were absent. `windows-preflight.log` and `windows-standard-paths.log` retain output. No dependencies were installed, files transferred, native lifecycle executed, or remote user-home/profile settings changed. Native exact-revision Windows build, PowerShell 5.1/7 lifecycle and junction/busy-executable acceptance remain blocked pending an equipped host or native CI. This preflight does not assert that all possible custom toolchain locations were searched.

Independent parent review and integration remain pending. No push, PR, publication, Linux native run or exact-head native CI is claimed. Companion documentation remains parent-owned before publication. Alpha shell/completions, v1-to-v2 npm/direct migration, updater ownership transition, and wider interactive/launcher/topology/hooks/recovery/remote-sync acceptance remain separate gates in the support ledger.
