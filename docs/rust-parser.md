# Native parser compatibility slice

`src/rust/parser.rs` owns structural parsing and non-TTY help. `cli::Args` and command dispatch remain unchanged; `cli::parse` is a re-export. Entry consumes the normalized command/options once, so short clusters also select JSON, verbose, and short rendering correctly. No TypeScript runtime fallback exists. Unsupported command bodies still return `RUST_NOT_YET_PORTED` before mutation. Help registration is not business-logic implementation.

## Source findings and integration

- Commander separates operands from unknown arguments at each command level. Root version handling, help positioning, consumed help-like option values, `--`, and nested `shell`/`completion` commands must use this order rather than raw first-token detection.
- Commander permits excess positionals in this retained version. Native now checks required positionals and passes only declared non-variadic arguments to actions. Existing command-domain validation remains untouched.
- Scalar repeats are last-value-wins; repeatable options retain encounter order. Selector options have `repeatable: false` in the structural contract but explicitly accept repetition in `semanticPolicy.selector.accepts`; that policy is required to avoid silently losing selections.
- Dual positive/negated options keep only the last explicitly selected spelling in Args. Defaults are intentionally left to domain consumers; Args remains an explicit-input representation.
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
- Command-owned JSON guards and bespoke parser overrides (notably exec/handoff/create/switch) require command-lane integration. Unknown exec options currently fail closed in the structural parser; do not treat this as source's full bespoke error-envelope behavior.
- No complete Commander reimplementation claim: optional-value/alias/variadic-option registrations absent from the retained contract, unusual Unicode suggestion ordering, ancestor-option typo suggestions, and extreme numeric spelling edge cases remain unverified.
- Domain workers should adapt only entry/parse integration mechanically, preserving their dispatch bodies. Nested command dispatch receives canonical space-separated paths. Completion's existing runner still receives original raw argv because its protocol is lossless.
- Independent parent review and exact-head cross-platform validation remain required. TypeScript, dependencies/locks, stable distribution/signing, companion repositories, and other worktrees were not modified.
