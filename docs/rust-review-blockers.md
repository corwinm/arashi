# Review-blocker correction evidence

Baseline: `eae9b4be5ab5d9ebab65a4c0ffb6c48f8bcae8ef` (clean before edits).
These corrections stay inside the native parent-shell/configure subset. No launcher,
publication, distribution, stable v1, or companion-repository changes are included.
Independent exact-head review is reserved for the parent; these results are not
an independent-review approval.

## Source-first characterization and RED

Before production edits, ran `node tests/rust/review-blockers-source.mjs`:

```text
Retained TS: 13 IDE/resolution cases, 4 managed precedence cases, 3 inherited-base cases passed; no launcher executed.
```

The script imports the retained detector, switch resolution and configured-base
resolver. It verifies Cursor-over-Kiro and managed-context precedence without
executing a launcher. Native detection returns only a boolean: either IDE causes
unsupported launch rejection, not selection or execution of an editor.

Added three regressions and ran:

```sh
export CARGO_HOME="$PWD/target/cargo-home"
export CARGO_TARGET_DIR="$PWD/target"
export ARASHI_TS_PARITY=1
cargo test --offline --locked --test rust_switch --test rust_configure   --no-fail-fast review_blocker -- --nocapture --test-threads=4
```

Exit 101, with three expected assertion failures before Rust production changes:

- Inherited repository base: actual `{"source":"inherited","value":"origin/develop"}`,
  expected `{"source":"inherited","value":"develop"}`. The retained CLI was run
  first in this regression and passed the normalized-value and full-snapshot checks.
- `TERM_PROGRAM=cursor`, configured auto, active shell: native exit 0 and
  `Prepared shell directory switch to ide-target ...`, instead of rejection.
- `TERM_PROGRAM=" VSCode "`: native rejected as managed; source treats the exact
  VS Code fallback case-sensitively and without trimming.

An initial configure fixture was missing required `reposDir`; that fixture was
corrected and RED rerun to obtain the actual normalization failure above.
Raw valid RED evidence remains in `target/review-blockers/red.log`.

## Fix and preservation coverage

- Recognize Cursor/Kiro across all five retained-source signals, then exact
  `TERM_PROGRAM=vscode` or present VS Code PID/IPC variables (including empty
  strings). Managed auto rejects before creating or replacing a directive.
- Preserve explicit `--cd`, configured `cd`, and unmanaged auto behavior;
  compare successful source/native directive bytes.
- Check absent and caller-owned directive files, configuration bytes, branch
  inventory, Git status and worktree registration on managed rejection.
- Strip exactly one `origin/` only from inherited repository effective base.
  Preserve workspace/repository configured values and full fixture/HOME bytes;
  compare complete configure JSON against the retained CLI. Include doubled
  `origin/` and non-origin prefixes.
- Add two preservation/oracle tests after GREEN; the original three regressions
  passed before the full gates below. Test environment removes inherited IDE
  variables before adding each explicit signal fixture.

## Validation

Local macOS run, using the lane-local cargo environment above. All commands
below exited 0. Test counts are aggregated from fresh `test result` lines;
none were failed or ignored.

| Gate            | Passed | Seconds |
| --------------- | -----: | ------: |
| fmt             |      — |    0.19 |
| clippy          |      — |    1.74 |
| focused-debug   |     66 |   20.81 |
| focused-release |     66 |   23.84 |
| integrated      |    311 |  368.77 |
| release-build   |      — |    0.14 |
| external-parity |     15 |   12.64 |
| diff-check      |      — |    0.03 |

Exact commands:

```sh
cargo fmt --check
cargo clippy --offline --locked --all-targets -- -D warnings
cargo test --offline --locked --test rust_config --test rust_configure --test rust_switch --test rust_shell --test rust_handoff -- --include-ignored --test-threads=4
cargo test --release --offline --locked --test rust_config --test rust_configure --test rust_switch --test rust_shell --test rust_handoff -- --include-ignored --test-threads=4
cargo test --offline --locked --all-targets -- --include-ignored --test-threads=4
cargo build --offline --locked --release
node tests/rust/parity.mjs target/release/arashi target/review-blockers/source-parity.json
git diff --check
```

Focused suites include config, configure, switch, shell and handoff. Existing
Bash/Zsh/Fish wrapper journeys ran inside source-enabled debug and release tests.
Static added-line scanning found no hardcoded-secret, shell-injection,
eval/exec or unsafe-deserialization matches; self-review and whitespace checks
passed. No retained TypeScript production/test or stable distribution path was
modified, so retained-source distribution build gates were not rerun.

The support ledger records the corrected scope. Companion documentation/skills
need no new workflow instructions for these parity corrections and were not edited.
Cross-platform CI and parent independent exact-head approval remain outside this
local validation.

## Local evidence hashes (SHA-256)

Raw logs and JSON stay under the ignored `target/review-blockers/` directory.
The committed characterization script and regressions reproduce the behavior.

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `source.log`          | `2bef55bc84d6246fad9fffc4f02b2cb95f7a7b73a1f7e198418d377bf49566d5` |
| `red.log`             | `de5ea80f8140793a98298e5c2c0b4ec299617f1e912dab3bb75b025412237ea5` |
| `green.log`           | `3fccbd78968cf3009cf158fa5c61754e1c5845f1a1d25edf74b6a362a7b59af7` |
| `results.json`        | `1430f763a96d61aa89ac977c13d07a5a91807b15f15818e677eaa911f48168df` |
| `focused-debug.log`   | `759a0b2cdd64fe6753533f13e24f5f85d2a6223013128a9673fabe3402174ea1` |
| `focused-release.log` | `794b3d3445a7e5db72960cee750916235b22d358cdd453d3a0c3f7f021389efc` |
| `integrated.log`      | `05bd687a7f28a757a3ac527b44e6c262fda6c798b84a7544b45c9bda53703ff0` |
| `source-parity.json`  | `ccab308029cc4d09a0b9d58ac184417974ef9440a47b504949c12e4ec3d27ac2` |
