# Shell Command

Manage shell integration for parent-shell directory switching.

## Usage

```bash
aw shell <subcommand>
```

## Subcommands

- `init <bash|zsh|fish>` Print wrapper code for a supported shell.
- `install` Detect the active shell and add an Arashi-managed init block to the matching startup file.
- `uninstall` Remove one exact complete Arashi-managed block from the deterministic startup file.

## Examples

```bash
# Install shell integration for the active shell
aw shell install

# Inspect, then remove only the exact managed block
aw shell uninstall --dry-run
aw shell uninstall --yes

# Print bash wrapper code for manual setup
aw shell init bash

# Print fish wrapper code for manual setup
aw shell init fish
```

## Notes

- `aw shell install` supports bash, zsh, and fish in the first release.
- If automatic install cannot detect a writable startup file, Arashi tells you to use `aw shell init <shell>` instead.
- Restart your shell or source the updated startup file after installation.
- Shell uninstall treats missing markers as a no-op and refuses malformed, nested, reversed, or duplicate markers before writing. It never removes executables, PATH state, manifests, or project data.
- Shell integration enables `aw switch --cd`, configured `cd`, and contextual `auto` to change the current shell directory instead of only opening a new terminal context. The full unified switch mode set is `auto` | `cd` | `launch` | `sesh` | `herdr`; `auto` first honors strict managed launcher contexts, then uses `cd` only when none is detected.
