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
- When status detects a missing configured repository, it recommends `arashi clone`.
- For existing local repositories that are not configured, clone offers reconciliation options in interactive mode.
