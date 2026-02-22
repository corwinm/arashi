// Core type definitions for Arashi

export interface ArashiConfig {
  version: string;
  reposDir: string;
  worktree_strategy: "same_branch";
  autoSetup: boolean;
  repos: {
    [repoName: string]: RepoConfig;
  };
}

export interface RepoConfig {
  path: string;
  defaultBranch: string;
  remote: string;
  has_setup_script: boolean;
  gitUrl?: string;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  head: string;
  isBare: boolean;
  repos: {
    [repoName: string]: {
      path: string;
      branch: string;
      status: "clean" | "dirty" | "error";
    };
  };
}

export interface CreateOptions {
  interactive?: boolean;
  only?: string[];
  path?: string;
}

export interface RemoveOptions {
  keepBranches?: boolean;
  keepWorktrees?: boolean;
  force?: boolean;
}
