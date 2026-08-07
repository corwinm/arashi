export const COMPLETION_CANDIDATE_KINDS = [
  "choice",
  "group",
  "repository",
  "shell",
  "workspace",
  "worktree",
] as const;

export type CompletionCandidateKind = (typeof COMPLETION_CANDIDATE_KINDS)[number];

export interface CompletionCandidate {
  description: string;
  value: string;
}
