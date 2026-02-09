# Setup Command

Run repository setup scripts across the workspace in one command.

## Usage

```bash
arashi setup [options]
```

## Options

- `--only <repo>` Run setup for a specific repository (repeatable)
- `-v, --verbose` Print full setup script output

## Examples

```bash
# Run setup for all configured repositories
arashi setup

# Run setup only for selected repositories
arashi setup --only api --only web

# Inspect script output while setup runs
arashi setup --verbose
```

## Notes

- Main repository setup runs before sub-repository setup.
- Repositories without setup scripts are reported as skipped.
- The command continues through repository failures and reports a final summary.
