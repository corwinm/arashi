export interface ConfiguredBaseOutcome {
  source: "repository-config" | "workspace-config";
  branch: string;
  state: "available" | "unavailable";
  remote: string | null;
  remoteRef: string | null;
  compareRef: string | null;
  ahead?: number;
  behind?: number;
  reason?: "comparison-failed" | "detached-head" | "refresh-failed" | "unresolved-target";
  details?: {
    error: string;
  };
}
