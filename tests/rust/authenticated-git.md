# Authenticated Git fixture (test-only)

`startAuthenticatedGit()` from `authenticated-git.mjs` creates two actual loopback
listeners and a private disposable directory. Requirements: Node 24, locked pnpm
dev dependencies, native Git, OpenSSL/LibreSSL, `ssh` and `ssh-keygen` on PATH.
`ssh2@1.17.0` is a dev dependency only. No production file or runtime adapter changes.

## API

Always `await fixture.close()` in `finally`.

- `root`, `remote`: private fixture directory and bare origin path.
- `urls.https`, `urls.ssh`: real transport URLs; never rewritten to file/Git.
- `git(cwd, args, { transport, mode })`: native Git, returning trimmed stdout.
- `run(executable, args, { cwd, transport, mode, allowFailure })`: isolated child,
  returning `{code, stdout, stderr}`. Cwds are relative to `root` or absolute.
  Native acceptance passes a Rust executable; source acceptance explicitly passes
  `src/index.ts` to Node. These are separate test modes, not runtime fallbacks.
- `mode`: `valid` (default), `wrong-credential`, or `wrong-trust`.
- `commit(cwd, label)`: random binary payload commit; returns its exact OID.
- `events`: secret-free authentication/backend observations, service and byte count.
- `assertNoSecretOutput()`: check retained child output for generated credentials
  and private-key markers. Command failures deliberately do not print raw output.

HTTPS uses a generated test CA and signed IP-SAN certificate, explicit verified CA
trust, and a private Git credential helper supplying a generated Basic password.
SSH uses generated host/client keys, strict private known-hosts files, no agent,
no password prompts, and ssh2's signed public-key verification. Only the exact
`git-upload-pack '/origin.git'` and `git-receive-pack '/origin.git'` exec requests
are accepted; there is no shell command execution on the server. HTTPS delegates
CGI to `git http-backend`. Both transports relay native Git packet/pack buffers,
not synthesized responses. Random binary payloads and exact OID checks exercise
clone, incoming fetch and outgoing publication.

Wrong CA/host key and wrong password/client key must fail for the corresponding
trust/authentication reason, without backend execution. Rejected pushes preserve
the remote OID. Successful controls preserve the original transport URL. The
application journey separately verifies add denial, add, clone, pull, push preview
nonpublication, push, persisted configuration and exact OIDs for both source and
native implementations. It does not claim complete output-envelope parity.

## Focused commands

```sh
node --test tests/rust/authenticated-git.test.mjs
node tests/rust/authenticated-git-acceptance.mjs source
node tests/rust/authenticated-git-acceptance.mjs native "$PWD/target/debug/arashi"
CARGO_HOME="$PWD/target/cargo-home" CARGO_TARGET_DIR="$PWD/target" CARGO_BUILD_JOBS=2 \
  ARASHI_TS_PARITY=1 cargo test --locked --test rust_authenticated_git \
  -- --include-ignored --test-threads=1
```

Native Windows acceptance uses the current user SID ACL before creating any fixture
contents, so every generated file inherits full control and recursive cleanup remains
owned. The isolated child environment retains Windows `ProgramData` for system
OpenSSH. Git keeps its installed default HTTPS backend; explicit CA-file trust and
Schannel CA-file opt-in preserve the same verification semantics across platforms.
Cleanup retries only Windows `EACCES`, `EBUSY`,
`ENOTEMPTY`, and `EPERM` for a bounded two seconds, then rethrows the filesystem
failure. A native lock-holder regression proves the transient-EPERM path.
The Rust native application journey remains Unix-gated until the separate Windows
identity/mutation foundation lands. Parent owns Windows scheduling and integration.

POSIX children have fixture-owned process groups; timeout/close kills only live
owned groups. Listeners bind ephemeral `127.0.0.1` ports, and close waits for
listeners/children before deleting the owned temporary directory. Nothing changes
host sshd, host accounts, user known_hosts, user Git configuration or real
credentials. No force-push, external remote writes or release publication.
