# Native parser compatibility slice

`src/rust/parser.rs` owns structural parsing and non-TTY help. `cli::Args` remains the explicit-input representation and `cli::parse` is a re-export. All integrated command bodies remain wired through the current dispatcher, with command-owned entry guards applied before domain planning. Entry consumes the normalized command/options once, so short clusters also select JSON, verbose, and short rendering correctly. No TypeScript runtime fallback exists. Unsupported command bodies still return `RUST_NOT_YET_PORTED` before mutation. Help registration is not business-logic implementation.

## Source findings and integration

- Commander separates operands from unknown arguments at each command level. Root version handling, help positioning, consumed help-like option values, `--`, and nested `shell`/`completion` commands must use this order rather than raw first-token detection.
- Commander permits excess positionals in this retained version. Native now checks required positionals and passes only declared non-variadic arguments to actions. Existing command-domain validation remains untouched.
- Scalar repeats are last-value-wins; repeatable options retain encounter order. Selector options have `repeatable: false` in the structural contract but explicitly accept repetition in `semanticPolicy.selector.accepts`; that policy is required to avoid silently losing selections.
- Structural dual positive/negated options keep only the last explicitly selected spelling in Args. The retained create action is an intentional exception: explicit `--launch` wins over `--no-launch` in either order. Entry applies that override after parsing, preserving pre-mutation rejection rather than accidentally enabling native creation. Defaults remain domain-owned.
- Invalid completion shell names are Commander exit-1 argument errors, not the previously asserted native exit-2 domain message. The focused completion expectation was corrected against actual source process output.
- The retained contract currently has no optional-valued options or command aliases. The scanner understands optional values and aliasPaths, but these branches have no active-source parity acceptance claim. The `aw` executable alias is retained and tested by `rust_cli`.

## Help artifact

`src/rust/parser-help.json` contains 28 actual source process captures: root and all help-enabled command paths. It preserves source usage names, argument descriptions, registration order, hidden flags, default/choice text, examples, and spacing. Internal completion query disables help. This is a compiled static artifact, not a dynamic source dependency.

Regenerate intentionally after source help changes:

```sh
ARASHI_TS_SOURCE=/absolute/path/to/retained/src/index.ts \
  node tests/rust/parser-parity.mjs target/debug/arashi target/parser-capture.json --capture-help
```

Normal parity runs compare against live source processes, not against the captured artifact, so stale captures fail. Version output always uses `CARGO_PKG_VERSION` (intentional source package difference).

## Verification

At the parser lane based on `d5ebd026fe6cb8e271d550f1f6811f07395f53bc`:

- Initial RED: 96 mismatches in 98 process comparisons (`target/parser-red.json`). Initial business-domain cases were subsequently replaced by parser-equivalent implemented install cases; domain errors were not disguised as grammar acceptance.
- Follow-up RED exposed lost repeated selectors (`target/parser-tests.log`), query help and typo suggestions (`target/parser-next-red.log`), and overly permissive numeric option parsing (`target/parser-numeric-red.log`).
- Final actual native/source process comparisons: **111/111**, exact stdout/stderr/status, disposable cwd/HOME preserved (`target/parser-process-parity.json`).
- Explicit option-value/positional observations: **7/7** separate native test-probe and retained-source program processes (`target/parser-values.json`). Only source actions are replaced by an observer; registration/parsing remain retained source. This supplements, not replaces, real CLI process comparisons.
- Focused Cargo targets: `rust_parser`, `rust_cli`, `rust_completion`: **32 passed, zero failed/ignored**, using `--include-ignored` (`target/parser-focused-final.log`).
- `cargo fmt --check`, locked/offline all-target clippy `-D warnings`, and `git diff --check` passed. No overlapping full suites were run.

Reproduce with dependencies installed for the retained source:

```sh
ARASHI_TS_SOURCE=/absolute/path/to/retained/src/index.ts \
  cargo test --locked --test rust_parser --test rust_cli --test rust_completion -- --include-ignored
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
```

## Remaining compatibility boundaries

- Help is deliberately the non-TTY/plain source surface. Dynamic terminal-width wrapping, colored/graphical root banners, and other TTY styling remain unported.
- Integrated entry preserves switch JSON guards, handoff consumed flag-like context values and command-family shell envelopes/rendering. Exec allows unknown options as child argv and leaves missing-command/jobs/workspace validation to its domain layer. Help is checked across the unknown-argument tail, including after a retained `--`, matching Commander; a clean child-argv separator still protects child help/JSON flags. Create preserves the source action's positive-launch override and tab/tmux JSON guard → launcher-conflict → other interactive/launch JSON guard ordering. None of this enables native terminal/editor launchers.
- No complete Commander reimplementation claim: optional-value/alias/variadic-option registrations absent from the retained contract, unusual Unicode suggestion ordering, ancestor-option typo suggestions, and extreme numeric spelling edge cases remain unverified.
- Nested dispatch receives canonical space-separated paths; shell output retains the `shell` command family rather than rendering or enveloping `shell init` as a new family. Completion's existing runner still receives original raw argv because its protocol is lossless. Integrated add/clone, configure, delete, move, pull/push, sync, handoff, switch and shell dispatch bodies and all existing success/partial-failure renderers are preserved.
- Independent parent review and exact-head cross-platform validation remain required. TypeScript, dependencies/locks, stable distribution/signing, companion repositories, and other worktrees were not modified.

## Integrated v2 verification

Baseline `e64833a758c1a2e634ba2b6cc583ab97cf4ba469`; recovered parser parent `09226357b28ac689e93c7c56d5ba4cc108e2d3b5`. The recovered worktree was clean at that exact object, and its 111 process comparisons and seven value observations were checked programmatically before integration.

New real-process regressions cover nested shell output, exec unknown options and error ordering, unknown-tail help, flag-like handoff values, repeated selectors and short rendering clusters, configured create/dry-run/remove and source create launch-guard ordering. Configure's old excess-operand rejection assertion was replaced with retained-source success plus complete fixture/HOME snapshots. No source-text assertions were added. All pre-existing dispatch/renderers are byte-preserved apart from the explicit create preflight insertion; no domain mutation or ownership primitive was replaced.

Sequential local macOS acceptance, with lane-local `CARGO_HOME` and `CARGO_TARGET_DIR`, locked/offline Cargo and `ARASHI_TS_PARITY=1`:

- All-target integrated suite: **433 passed, 0 failed, 0 ignored**.
- Focused release command/parser suites: **145 passed**; release configured parser composition: **2 passed**; release lifecycle: **21 passed**. All have zero failed/ignored tests.
- Latest actual source/native parser process comparisons: **133/133**, with **8/8** structural value observations.
- Cargo fmt, included-fixture rustfmt, host all-target clippy with `-D warnings`, release build and whitespace checks: passed.
- Windows GNU all-target check/clippy with `-D warnings`: passed. These are cross-target checks, **not native Windows execution or linked Windows binaries**.
- External release source parity **15/15**, native smoke **12/12**, characterization **19/19**.

An early full run was killed by the foreground tool's effective 420-second timeout and is not acceptance. The coherent background integrated run passed. The first release cohort hit the existing large-completion-output timing assertion (release ignores the debug-only test-budget override and uses the 200 ms production deadline). The unchanged focused completion retry passed **12/12**, followed by a complete unchanged release cohort pass; no deadline, assertion or production completion code was weakened.

Evidence: `target/parser-integration-validation.json`, `parser-final-gates.json`, `parser-final-manifest.json`, `parser-integration-self-review.md` and `parser-final-*.log/json`; reproducible sequential runners are `target/validate-parser-final.py` and its post-retry continuation `target/validate-parser-remaining.py`. Failed/partial evidence remains in `parser-integration-{red,first-all,second-all}.log`, `parser-shell-red.json`, `parser-create-guard-red.json`, `parser-unknown-help-red.json`, `parser-final-first-release-focused.log` and `parser-release-completion-retry.log`. Frozen source/test hashes matched after all final gates.

No TypeScript production, stable npm package, installer, dependency, workflow, signing setup or companion repository was changed. Test orchestration may use Python locally; the native CLI has no Python/Node/TypeScript runtime dependency. Local merge authorization does not establish independent approval of the new merge, exact-head platform CI or whole-port completion. TTY help, broader grammar/domain parity and native Windows acceptance remain open.
