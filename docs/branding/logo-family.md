# Arashi Logo Family

This document defines the canonical Arashi logo family and placement rules for text and docs surfaces.

## Canonical Assets

- Full text logo source: `repos/arashi/assets/logo/arashi-full.txt`
- Compact mark logo source: `repos/arashi/assets/logo/arashi-compact.txt`
- Vector mark source: `repos/arashi/assets/logo/arashi-mark.svg`

## Variant Rules

- Full text logo:
  - Unicode block/text mark design
  - Maximum width: 52 columns
  - Maximum height: 3 lines
  - Intended surfaces: README top placement, wide interactive CLI help
- Compact mark logo:
  - Unicode mark-only variant
  - Maximum width: 12 columns
  - Maximum height: 2 lines
  - Intended surfaces: constrained interactive CLI help
- Plain fallback text:
  - Value: `arashi`
  - Intended surfaces: non-interactive and very narrow CLI output

## Surface Placement Map

- `repos/arashi/README.md`: full text logo appears before the H1 heading.
- `arashi -h` output: full/compact/plain variant selected by terminal context.
- `repos/arashi-docs` site header and favicon: vector mark family assets.

## README Rendering Constraints and Fallbacks

- Keep the README logo in a fenced `text` block to preserve spacing.
- Use a monospace font context for readability of block glyphs.
- If a renderer collapses spacing, keep a plain `# Arashi` heading directly below the logo.
- If future edits require a narrower variant in markdown, use the compact mark logo before changing shape details.

## CLI Help Banner Rules

- Full variant when interactive and terminal width is at least 100 columns.
- Compact variant when interactive and terminal width is at least 60 but below 100 columns.
- Plain text variant when terminal width is below 60 or output is non-interactive.

## Verification Record

- 2026-02-11 README logo check: full text logo renders above heading in markdown.
- 2026-02-11 CLI width checks:
  - 120 columns: full variant selected.
  - 100 columns: full variant selected.
  - 80 columns: compact variant selected.
  - 60 columns: compact variant selected.
  - Non-interactive output: plain `arashi` selected.
