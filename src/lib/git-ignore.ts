export interface GitIgnoreVerboseEvidence {
  ignored: boolean;
  line?: number;
  metadata: string;
  pattern: string | null;
  source: string | null;
}

/** Parse one `git check-ignore --verbose` result, including negated matches. */
export function parseGitIgnoreVerbose(output: string): GitIgnoreVerboseEvidence {
  const metadata = output.trim().split("\t", 1)[0] ?? "";
  const match = metadata.match(/^(.*):(\d+):(.*)$/);
  const pattern = match?.[3] ?? null;
  return {
    ignored: metadata.length > 0 && pattern?.startsWith("!") !== true,
    ...(match ? { line: Number(match[2]) } : {}),
    metadata,
    pattern,
    source: match?.[1] ?? (metadata || null),
  };
}
