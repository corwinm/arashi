# `aw delete`

Delete one or more configured repository dependencies without overloading branch/worktree removal.
`aw delete <repository>` targets one exact `repos` key. In a human TTY, `aw delete` opens a
checkbox list of configured keys; JSON and non-interactive use require the exact key.

Preview before accepting deletion:

```bash
aw delete <repository> --dry-run
aw delete <repository> --force
```

The preview lists the canonical clone, owned linked worktrees and metadata, local refs, the exact
configuration entry, exact workspace-owned `pre-create.<repository>`, `post-create.<repository>`,
`pre-remove.<repository>`, and `post-remove.<repository>` hooks and concrete templates, warnings, and
user-global hooks that will be preserved. Compatible child-local remove hooks are removed only with
their owned clone/worktree, not as separate workspace-hook items. `--force` bypasses confirmation and disclosed Git
data-loss guards only. It does not override configuration, topology, containment, symlink,
identity, hook-ambiguity, or concurrent-change checks. Remote repositories, remote branches,
shared and user-global hooks, unrelated configuration, and managed-ignore state are preserved.

`aw remove` removes branch worktrees. It is not an alias for deleting a configured dependency.

For automation, use one-document JSON output:

```bash
aw delete <repository> --dry-run --json
aw delete <repository> --force --json
```

A dry-run exposes `data.plan` and has `data.result: null`. A mutating failure preserves the
accepted scope and phase ledger in `error.details.plan` and `error.details.result`. Read the
structured item and phase states rather than parsing human output. Hook identity, path, and status
may appear, but hook contents and inline command bodies do not.

After a partial failure, inspect completed phases and surviving state. Retry only when the result
marks retry as safe, using its literal per-repository argument vector; otherwise follow its manual
inspection guidance. Deletion does not claim rollback of already removed Git or filesystem state.
