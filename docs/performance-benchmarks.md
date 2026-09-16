# CLI performance benchmarks

Use the repository contributor toolchain: Node.js 24.18.0 or later and pnpm 11.22.0. The package's
broader `engines.node` range applies to the installed npm launcher, not repository development
scripts.

Run the complete deterministic local suite with one command:

```bash
pnpm benchmark
```

The command builds the native executable and creates three fresh fixtures: `small` (2 repositories,
2 workspace worktrees, and 2 coordinated child worktrees), `medium` (4 repositories, 4 workspace
worktrees, and 12 coordinated child worktrees), and `large` (8 repositories, 6 workspace worktrees,
and 40 coordinated child worktrees). It warms each command, records measured samples, and writes JSON
to `benchmark-results/`. All fixtures assign repositories to the `benchmark-core` and
`benchmark-support` groups and use local filesystem Git remotes. Fixture construction ignores host
system/global Git configuration and uses an empty hooks directory, so user signing, templates, and
hooks cannot alter setup.
The same isolated Git configuration and hooks environment is passed to benchmarked Git-heavy CLI
invocations, Trace2 probes, and RSS samples, not only to fixture construction. Recursive fixture
cleanup uses three bounded retries with a short delay for transient Windows file locks.

Completion coverage uses the lossless `completion __query` protocol throughout:

- `completion-static-query` captures and asserts the static `status` command candidate.
- `completion-repository`, `completion-group`, and `completion-worktree` capture and assert candidates
  discovered from fixture configuration and Git worktree topology.

`status-local` and `status-refreshed` run against the same tracked-remote fixture through the compiled
CLI. The former invokes public `aw status --local --json`, which never fetches and reports that it used
existing remote-tracking refs. The latter invokes normal `aw status --json`, including its default
local-remote refresh. Matching `status-local-verbose` and `status-refreshed-verbose` cases exercise
verbose collection. Runtime methods and refresh semantics are recorded in each result.

The `create-coordinated` and `remove-coordinated` cases exercise real mutating CLI workflows across
two selected repositories, keeping the stateful portion representative but bounded as fixtures scale.
Fixture helpers reset the dedicated benchmark branches and worktrees before every warm-up, measured
sample, Trace2 invocation, and RSS probe. Each invocation validates both structured command output and
the resulting branch/worktree state, so stale state cannot make later samples incomparable.

Result schema version 5 separates runtime provenance at two levels. Top-level `runtime.runner`
identifies the Node process executing the benchmark harness. The one-command orchestrator resolves one
specific Bun executable, probes its version, uses that same executable to build, and writes a temporary
provenance record containing the compiler version and the built artifact's SHA-256, filename, and size.
The runner verifies that record against the exact executable before `runtime.build` reports a compiler
version. Direct `pnpm benchmark:run` has compiler provenance unavailable even when Bun is on `PATH`;
it never attributes an existing, stale, or downloaded binary to an unrelated compiler probe. The
top-level `artifact` identity still records path-neutral filename, byte size, and SHA-256 for direct-run
comparisons, without exposing an absolute machine path. Source mode remains explicitly not applicable.
Each command has its own `runtime`: normal default-mode commands are marked as compiled Bun
executables and `--source` commands as Node source invocations. The embedded Bun runtime version
remains unavailable because it is not introspected from the compiled executable.

Each command records sorted samples, median, nearest-rank p95, exit code, and direct
Arashi-originated Git process count and a canonical-worktree per-repository breakdown. Git counts use
root sessions from `GIT_TRACE2_EVENT`, associate each root session with its Trace2 `def_repo` worktree,
and exclude Git subprocesses launched by Git itself. Sessions without a provable repository identity
are reported separately as unattributed rather than guessed from argv. A separate support probe seeds a recognized Trace2 event, so
a supported trace with no Arashi-started Git process is available with count zero; missing, unreadable,
or unrecognized trace output is unavailable. Every measured sample contains `wallMs` and a `cpu`
availability record. On macOS/Linux, `/usr/bin/time -p` reports user and system CPU milliseconds for
the same child invocation; wall time is still measured by the Node harness at higher resolution.
Platforms without a truthful privilege-free adapter record CPU as unavailable with a reason rather
than zero. Peak RSS is collected in a separate invocation with the host `time` tool on macOS/Linux
when available, so memory sampling does not alter the measured samples. Unsupported metrics are
explicitly marked unavailable. Executable size is reported for the built binary. `--no-metrics`
disables CPU, RSS, and executable-size probes explicitly.

Use `--fixture small`, `--fixture medium`, or `--fixture large`, `--warmup N`, `--iterations N`, `--no-metrics`, and
`--output PATH` with `pnpm benchmark:run -- ...` for focused runs. Benchmark tests are opt-in through
`pnpm benchmark:test`; `pnpm test` does not discover them.

## Comparing a candidate with its base

Run `pnpm benchmark` in clean worktrees for the base and candidate using the same machine, power
mode, runtime versions, warm-up, and iteration count. Keep the two JSON artifacts and compare each
fixture/command's median, p95, and Git count. Treat wall time as evidence rather than a pass/fail gate;
Git counts are usually the more stable regression signal. Compare the runner, build, and per-command
runtime metadata before comparing samples. The JSON records runtime and platform but cannot normalize
background load.

## CI policy

The manual **CLI Benchmarks** workflow runs the same command on macOS, Linux, and Windows and
uploads each JSON result. It is informational and never runs on pull requests. No wall-clock threshold
is enforced: hosted-runner contention makes latency gates flaky, and representative baselines do not
yet justify global tolerances. Refresh uses local remotes; remote-host performance remains outside
deterministic CI.

## Invocation-scoped status probes

Refreshed status uses one Git probe context for configured repositories or standalone worktrees.
Repository identity comes from Git's common directory; worktree-local status and HEAD-relative
comparisons remain scoped to the canonical worktree. Failed read probes are evicted for retry.
Fetches serialize repository mutations and invalidate ref snapshots before and after each attempt,
including failed fetches. Cross-worktree fetch sharing requires exact effective configuration and
spawn semantics, with a positive proof that changing the execution directory cannot change the
operation. Ambiguous helpers, configuration, environments, or relative endpoints run separately.

On a Git version supporting `%(ahead-behind:HEAD)`, the clean tracked fixture uses at most seven
root Git sessions per named repository (eight with native verbose status): combined identity,
exact NUL configuration, one porcelain-v2 status, pre-fetch refs, targeted fetch, post-fetch refs,
and an optional symbolic remote-HEAD fallback. Older supported Git uses a metadata snapshot and
scoped `rev-list` comparisons; those extra compatibility probes must not be reported as meeting
the optimized budget. Local mode never calls fetch and disables Git's implicit promisor lazy fetch.

For issue #372, compare independently built binaries against CLI base
`b648825295a5c342b6920be0585711678377b452` through the same external adapter and fixture instance.
Record source and executable hashes, build environment, runtime versions, topology, command argv,
warmups, samples, and Trace2 attribution. Require semantic equality, including native verbose output,
and strictly lower counts for every named repository and the aggregate. Named counts plus explicit
unattributed counts must reconcile; any unexplained candidate session invalidates the comparison.
The pinned small normal/verbose totals are 39/42, and the large totals are 93/102.
