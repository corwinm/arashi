# Uninstall Command

Conservatively remove Arashi only when one installation owner is proven.

```bash
aw uninstall --dry-run
aw uninstall --yes
```

`--dry-run` (`-n`) prints the complete plan without prompting, staging a helper, or changing
anything. Interactive confirmation defaults to no; non-interactive removal requires `--yes` (`-y`).

For a current official direct install, schema-v2 ownership records exact payload digests and the
exact installer-created PATH state. The bundled `uninstall.sh` or `uninstall.ps1` helper locally
revalidates that manifest, skips exact already-absent payload files, removes safe PATH and shell
state, removes payload files, and removes the manifest last. It never recursively deletes the
install directory.

Package installations delegate once to the proven npm, pnpm, Yarn classic, Bun, or Vite+ owner.
Legacy direct installs must refresh the same location with the current official installer before
retrying. Manual, modified, malformed, unsupported, or ambiguous state refuses automatic removal.

Workspaces, repositories, worktrees, `.arashi.yaml`, Git metadata, project files, configuration,
unrelated profile bytes, package-manager roots, and unrelated install-directory files are
preserved.
