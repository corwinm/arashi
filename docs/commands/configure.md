# `aw configure`

Inspect or interactively edit supported settings in an existing configured workspace.

```bash
aw configure
aw configure --json
```

Interactive editing requires TTY stdin and stdout. The JSON form is sanitized, non-mutating
inspection: it never prompts and reports lifecycle/interpreter presence without inline command
bodies or native-file contents. Missing, standalone, malformed, and semantically invalid
configuration is rejected before either prompting or inspection; configure does not initialize,
migrate, repair, or save such a file.

## Supported scopes

- Workspace: `reposDir`, `worktreesDir`, `baseBranch`, and `sync.timeoutSeconds`.
- Workspace hooks: `hooks.timeout` and `pre-create`, `post-create`, `pre-remove`, and `post-remove`.
- Command defaults: create `switch` and `launch`, plus switch `mode`.
- Editor create defaults: `switch` and `launch` for VS Code, Cursor, and Kiro.
- Meta repository: `meta.baseBranch`.
- Existing repositories: `groups`, `baseBranch`, `copy`, `symlink`, and the four lifecycle hooks.

Repository `path` and `gitUrl` identify the selected repository and are not editable here. Edit
`.arashi/config.json` directly for other schema fields.

## Persisted and effective values

Each setting is labeled `Configured` or `Not configured`. Effective inherited and built-in values
are shown separately and are not persisted merely by inspection. Runtime built-ins include a
300-second sync timeout, a 300000-millisecond hook timeout, create switch `false`, create launch
`none`, and switch mode `launch`. `auto` remains an explicit context-sensitive switch mode.
Repository and meta base branches inherit the workspace `baseBranch` when their owning override is
absent.

## Editing and confirmation

Choose keep, edit, or clear for a selected field; required `reposDir` cannot be cleared. Invalid
input returns to the owning setting. Before confirmation, Arashi validates the complete candidate
and shows the exact JSON bytes to be saved. Planned active hook files are listed separately without
their generated contents.

Existing native hook files are observed through metadata only. Configure offers keep/skip and never
deletes, clears, overwrites, or includes them in a creation plan. New hook files use the canonical
active path, safe no-op scaffold, executable-ready mode on POSIX, and no-replace installation.
For repository remove hooks, that canonical path is
`.arashi/hooks/<lifecycle>.<repository><ext>` under the active configuration root, while an existing
`<repository>/.arashi/hooks/<lifecycle><ext>` remains a compatible source. Inline, canonical, and
compatible forms share one slot with no precedence. Configure refuses to publish a canonical file if
either file location or inline configuration already claims the slot, and rechecks both locations
during publication. The hook retains the plain lifecycle name and repository identity and executes
from the target repository checkout. POSIX scaffolds use `.sh`; Windows scaffolds use `.ps1`, while
runtime also recognizes `.cmd` and `.bat` candidates.

Keeping or skipping every selection preserves the original configuration bytes and exits before
final confirmation. Declining the final preview or pressing Ctrl+C also leaves configuration and
active files unchanged. A confirmed update rechecks the original bytes under the workspace
transaction lock, installs only absent planned files, saves configuration at most once, and rolls
back only files and bytes still owned by that transaction.
