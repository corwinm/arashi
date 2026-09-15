# CLI performance benchmarks

Run the complete deterministic local suite with one command:

```bash
pnpm benchmark
```

The command builds the native executable, creates fresh `small` (2 repositories, 2 workspace
worktrees, and 2 coordinated child worktrees) and `larger` (8 repositories, 6 workspace worktrees,
and 40 coordinated child worktrees) fixtures, warms each command, records measured samples, and
writes JSON to `benchmark-results/`. Both fixtures assign repositories to the `benchmark-core` and
`benchmark-support` groups and use local filesystem Git remotes.

Completion coverage uses the lossless `completion __query` protocol throughout:

- `completion-static-query` captures and asserts the static `status` command candidate.
- `completion-repository`, `completion-group`, and `completion-worktree` capture and assert candidates
  discovered from fixture configuration and Git worktree topology.

`status-local` and `status-refreshed` run against the same tracked-remote fixture. The former uses the
benchmark-only `checkAllRepos-without-fetch` invocation, injecting a successful no-fetch dependency
into Arashi's existing status collector. The latter invokes normal `aw status --json`, including
its default local-remote refresh. These runtime methods and refresh semantics are recorded in each
result; no public status option or normal CLI behavior is added or changed.

Each command records sorted samples, median, nearest-rank p95, exit code, and direct
Arashi-originated Git process count. Git counts use root sessions from `GIT_TRACE2_EVENT`, excluding
Git subprocesses launched by Git itself. A separate support probe seeds a recognized Trace2 event, so
a supported trace with no Arashi-started Git process is available with count zero; missing, unreadable,
or unrecognized trace output is unavailable. Peak RSS is collected separately with the host `time` tool on
macOS/Linux when available, so memory sampling does not alter timing. Unsupported metrics are
explicitly marked unavailable. Executable size is reported for the built binary.

Use `--fixture small` or `--fixture larger`, `--warmup N`, `--iterations N`, `--no-metrics`, and
`--output PATH` with `pnpm benchmark:run -- ...` for focused runs. Benchmark tests are opt-in through
`pnpm benchmark:test`; `pnpm test` does not discover them.

## Comparing a candidate with its base

Run `pnpm benchmark` in clean worktrees for the base and candidate using the same machine, power
mode, runtime versions, warm-up, and iteration count. Keep the two JSON artifacts and compare each
fixture/command's median, p95, and Git count. Treat wall time as evidence rather than a pass/fail gate;
Git counts are usually the more stable regression signal. The JSON records runtime and platform but
cannot normalize background load.

## CI policy

The manual **CLI Benchmarks** workflow runs the same command on macOS, Linux, and Windows and
uploads each JSON result. It is informational and never runs on pull requests. No wall-clock threshold
is enforced: hosted-runner contention makes latency gates flaky, and representative baselines do not
yet justify global tolerances. Refresh uses local remotes; remote-host performance remains outside
deterministic CI.
