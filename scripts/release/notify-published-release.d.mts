export type GitHubRequest = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;

export function notificationMarker(version: string): string;
export function isExactVersion(version: string): boolean;
export function extractClosingReferences(
  text: string | undefined,
  owner: string,
  repo: string,
): number[];
export function notifyTarget(options: {
  number: number;
  owner: string;
  releaseUrl: string;
  repo: string;
  request: GitHubRequest;
  version: string;
}): Promise<"existing" | "missing" | "notified">;
export function releaseCommits(options: {
  currentTag: string;
  owner: string;
  repo: string;
  request: GitHubRequest;
}): Promise<{ commits: unknown[]; releaseUrl: string }>;
export function notifyPublishedRelease(options: {
  owner: string;
  repo: string;
  request: GitHubRequest;
  version: string;
}): Promise<void>;
