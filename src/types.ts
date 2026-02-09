// Core type definitions for Arashi

export interface ArashiConfig {
  version: string;
  repos_dir: string;
  worktree_strategy: "same_branch";
  auto_setup: boolean;
  discovered_repos: {
    [repoName: string]: RepoConfig;
  };
}

export interface RepoConfig {
  path: string;
  default_branch: string;
  remote: string;
  has_setup_script: boolean;
  git_url?: string;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  head: string;
  is_bare: boolean;
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
