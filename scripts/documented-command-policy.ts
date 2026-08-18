import { join, relative } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const commandNames = [
  "add",
  "clone",
  "completion",
  "create",
  "doctor",
  "exec",
  "handoff",
  "init",
  "install",
  "list",
  "move",
  "prune",
  "pull",
  "push",
  "remove",
  "setup",
  "shell",
  "status",
  "switch",
  "sync",
  "update",
];

const legacyInvocation = new RegExp(
  String.raw`(?:\bcommand\s+)?(?<![./@-])\barashi\s+(?:--(?:help|version)\b|-[hV]\b|<command>(?=\s|\u0060|$)|(?:${commandNames.join("|")})\b)`,
  "g",
);
const compatibilityNote =
  "`arashi` executable remains supported for existing scripts and workflows";

export interface DocumentedCommandDefect {
  line: number;
  source: string;
  text: string;
}

export function findPreferredArashiInvocations(
  content: string,
  source: string,
): DocumentedCommandDefect[] {
  const defects: DocumentedCommandDefect[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.includes(compatibilityNote)) {
      continue;
    }
    legacyInvocation.lastIndex = 0;
    if (legacyInvocation.test(line)) {
      defects.push({ line: index + 1, source, text: line.trim() });
    }
  }
  return defects;
}

function markdownFiles(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(root, path);
    }
    return entry.name.endsWith(".md") ? [relative(root, path)] : [];
  });
}

export function checkMaintainedCliDocs(root: string): DocumentedCommandDefect[] {
  const sources = ["README.md", "CONTRIBUTING.md", ...markdownFiles(root, join(root, "docs"))];
  return sources.flatMap((source) =>
    findPreferredArashiInvocations(readFileSync(join(root, source), "utf8"), source),
  );
}
