# Clone Command

Clone missing configured repositories in the current Arashi workspace.

## Usage

```bash
arashi clone [options]
```

## Options

- `--all` Clone every missing configured repository without interactive selection

## Examples

```bash
# Select missing repositories interactively
arashi clone

# Clone all missing repositories at once
arashi clone --all
```

## Notes

- `arashi clone` only targets repositories that are configured but missing locally.
- If no repositories are missing, the command exits successfully without cloning.
- Inside a coordinated worktree, `arashi clone` completes missing child repositories by adding worktrees from the source workspace on the current branch when possible.
- Outside a coordinated worktree, or when no local source repository is available, `arashi clone` falls back to a normal remote clone.
- Default human `arashi status` output hides intentionally missing child repositories; use `arashi status --verbose` or `arashi status --json` to inspect missing configured repositories.
- For existing local repositories that are not configured, clone offers reconciliation options in interactive mode.
