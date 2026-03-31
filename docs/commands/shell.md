# Shell Command

Manage shell integration for parent-shell directory switching.

## Usage

```bash
arashi shell <subcommand>
```

## Subcommands

- `init <bash|zsh|fish>` Print wrapper code for a supported shell.
- `install` Detect the active shell and add an Arashi-managed init block to the matching startup file.

## Examples

```bash
# Install shell integration for the active shell
arashi shell install

# Print bash wrapper code for manual setup
arashi shell init bash

# Print fish wrapper code for manual setup
arashi shell init fish
```

## Notes

- `arashi shell install` supports bash, zsh, and fish in the first release.
- If automatic install cannot detect a writable startup file, Arashi tells you to use `arashi shell init <shell>` instead.
- Restart your shell or source the updated startup file after installation.
- Shell integration enables `arashi switch --cd` and `defaults.switch.mode: "cd" | "auto"` to change the current shell directory instead of only opening a new terminal context.
