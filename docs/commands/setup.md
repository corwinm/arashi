# Setup Command

Run repository setup scripts across the workspace in one command.

## Usage

```bash
aw setup [options]
```

## Options

- `--only <repo>` Run setup for a specific repository (repeatable)
- `-v, --verbose` Print full setup script output

## Examples

```bash
# Run setup for all configured repositories
aw setup

# Run setup only for selected repositories
aw setup --only api --only web

# Inspect script output while setup runs
aw setup --verbose
```

## Notes

- Main repository setup runs before sub-repository setup.
- Repositories without setup scripts are reported as skipped.
- The command continues through repository failures and reports a final summary.
