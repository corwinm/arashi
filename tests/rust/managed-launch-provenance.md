# Managed-launch source characterization (implementation blocked)

Oracle revision: `07c77e0fa4b79ec3d2902ad5aecca05ad16a52ae`.
No native managed adapter is implemented or claimed by this fixture commit.

Run from this worktree with its frozen pnpm dependencies installed:

```sh
node tests/rust/managed-launch-source.mjs target/managed-source-characterization.json
node tests/rust/managed-launch-native-tmux.mjs
```

The first driver executes the retained TypeScript through Bun, using the actual source process runner and disposable executable protocol fixtures. It validates ordered argv, cwd, directive removal, denial/malformed responses, and no fallback. The 19 cases cover all five families. These executable fixtures are not vendor applications and do not prove socket or GUI integration. The second driver uses the installed tmux with a private socket, private HOME, and `/dev/null` configuration. It verifies the actual created windows and quoted cwd by readback, and kills only its own server in cleanup.

## Source-contract discrepancy requiring parent resolution

The assigned worktree does not contain `src/lib/switch/managed-*` files. Its retained `src/lib/switch-launcher.ts` implements:

- tmux: `tmux new-window -c <path>` for both dispositions, without session discovery/reuse or `cd` input.
- sesh: requires active tmux and an available sesh binary; runs `tmux new-window -c <path> "sesh connect '<quoted-path>'"`. Session internals are delegated to sesh, not inspected by Arashi.
- Herdr: ordered `worktree open` / targeted `tab create`; validates structured identities. `already_open` comes from the vendor response.
- cmux: `cmux workspace create --cwd <path> --focus true --json` for both dispositions. No workspace/repository discovery, surface reuse, multipanes, or environment rebinding. In particular, source tab behavior conflicts with the assigned explicit no-window-fallback/targeted-tab requirement.
- Kitty: resolves/version-checks `kitten`, locks canonical-path identity, runs `kitten @ ls`, exact marker focus/reconciliation or session-backed tab launch, validates state. No native DCS/TCP/Unix transport exists in Arashi; the external kitten implements transport. The retained source always uses `--type=tab`, even for window disposition.

Implementing the requested richer behavior and calling it retained-source parity would be false. Parent must identify a different exact retained source revision/location or explicitly approve the behavioral delta and its reference contract.

## Dependency boundary

The proposed interface was inspected at sibling `v2-switch/repos/arashi/target/launch-interface.md`. At inspection its actual `src/rust/launch.rs` and `src/rust/launch/` remained untracked, with HEAD still the oracle revision above. Per assignment, this lane did not blindly copy unstable files, modify shared launch/lib/Cargo modules, or fabricate a managed executor for compilation. Parent must publish the launcher dependency commit before adapter implementation/testing.

## Local evidence and limits

- `target/managed-source-characterization.json`: all 19 subprocess cases passed; embeds source Git blob IDs and observed commands.
- `target/managed-native-tmux.log`: installed tmux 3.7c; two real source launches yielded window counts 2 then 3 in the same disposable session, all with the requested quoted cwd.
- Read-only version probes: sesh 2.28.0, Herdr 0.7.4, bundled kitten 0.48.2. No cmux executable on inherited PATH. Version probes are not integration acceptance.
- No live Herdr/Kitty GUI or socket acceptance; no native Windows execution; no Rust RED/GREEN, debug/release, or clippy claims. Adapter implementation, independent review, integration, and verified v2 push remain pending.
