# Zero-config standalone workspaces

Arashi can manage one ordinary, non-bare Git repository without `.arashi/config.json`. Bootstrap the repository-local convention explicitly:

```sh
aw init --zero-config
aw create feat/example
aw list
aw status
aw switch feat/example
aw remove feat/example
```

Bootstrap creates the root `.worktrees/` directory and, only when Git does not already ignore the convention, appends the literal `.worktrees/` rule to the repository's common `info/exclude`. It never edits `.gitignore`, global Git configuration, or `.arashi/`. Use `--dry-run`, `--verbose`, and `--json` to preview or automate bootstrap; configuration-producing init options are incompatible with `--zero-config`.

Standalone worktrees use the exact path `.worktrees/<branch>`, including natural nested directories for branch names such as `feat/example`. Before create—even during dry-run—Arashi asks Git whether that exact destination is effectively ignored. If it is exposed by a missing or negated rule, run `aw init --zero-config` or add `.worktrees/` to the repository-local exclude file.

Standalone mode supports `create`, `list`, `status`, `switch`, `remove`, `prune`, `doctor`, `move`, and `handoff`. Repository/group selection and coordinated child-repository commands require persisted configuration. Run ordinary `aw init` to upgrade when you need child repositories, groups, custom worktree locations, configured defaults, or workspace/repository hooks.

The same workspace is discovered from its main worktree and linked worktrees. Existing configuration always takes precedence, and malformed or unsupported configuration is reported rather than hidden by standalone fallback.
