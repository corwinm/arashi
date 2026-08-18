import type { Config } from "./config.ts";
import { Option } from "commander";
import { isValidRequestedBaseBranch } from "./git-branch-name.ts";
import { normalizeLogicalBranchName } from "./git-branch-name.ts";

export type BaseBranchPolicySource =
  | "repository-cli"
  | "cli"
  | "repository-config"
  | "workspace-config"
  | "legacy-omitted";

export interface EffectiveBaseBranch {
  repositoryIdentity?: string;
  repositoryName: string;
  requestedBranch?: string;
  source: BaseBranchPolicySource;
}

export type BaseBranchPolicyIssueCode =
  | "MALFORMED_OVERRIDE"
  | "DUPLICATE_SELECTOR"
  | "INVALID_BRANCH"
  | "UNKNOWN_REPOSITORY"
  | "UNSELECTED_REPOSITORY"
  | "META_NOT_ALLOWED"
  | "STANDALONE_REPOSITORY_OVERRIDE";

export interface BaseBranchPolicyIssue {
  code: BaseBranchPolicyIssueCode;
  value: string;
  message: string;
}

export class BaseBranchPolicyError extends Error {
  readonly code = "BASE_BRANCH_POLICY_INVALID";
  readonly issues: readonly BaseBranchPolicyIssue[];

  constructor(issues: readonly BaseBranchPolicyIssue[]) {
    super(
      `Invalid base branch policy:\n${issues.map((issue) => `  - ${issue.message}`).join("\n")}`,
    );
    this.name = "BaseBranchPolicyError";
    this.issues = issues;
  }
}

const parseRepositoryBaseOverridesWithIssues = (
  values: readonly string[] = [],
): { parsed: ReadonlyMap<string, string>; issues: BaseBranchPolicyIssue[] } => {
  const parsed = new Map<string, string>();
  const issues: BaseBranchPolicyIssue[] = [];
  for (const value of values) {
    const separator = value.indexOf("=");
    const selector = separator < 0 ? "" : value.slice(0, separator);
    const branch = separator < 0 ? "" : value.slice(separator + 1);
    if (!selector || !branch) {
      issues.push({
        code: "MALFORMED_OVERRIDE",
        message: `'${value}' must use non-empty <repository=branch> syntax`,
        value,
      });
      continue;
    }
    if (!isValidRequestedBaseBranch(branch)) {
      issues.push({
        code: "INVALID_BRANCH",
        message: `'${value}' contains an invalid Git branch name`,
        value,
      });
      continue;
    }
    if (parsed.has(selector)) {
      issues.push({
        code: "DUPLICATE_SELECTOR",
        message: `Repository selector '${selector}' is repeated`,
        value,
      });
      continue;
    }
    parsed.set(selector, normalizeLogicalBranchName(branch));
  }
  return { parsed, issues };
};

export const parseRepositoryBaseOverrides = (
  values: readonly string[] = [],
): ReadonlyMap<string, string> => {
  const result = parseRepositoryBaseOverridesWithIssues(values);
  if (result.issues.length > 0) throw new BaseBranchPolicyError(result.issues);
  return result.parsed;
};

export interface ResolveBaseBranchPolicyInput {
  command: "create" | "clone";
  config: Config;
  selectedRepositoryNames?: readonly string[];
  selectedRepositories?: readonly BaseBranchRepositoryIdentity[];
  metaRepositoryName?: string;
  globalBase?: string;
  repositoryOverrides?: readonly string[];
  standalone?: boolean;
}

export interface BaseBranchRepositoryIdentity {
  configName?: string;
  identity: string;
  kind: "meta" | "child";
  repositoryName: string;
}

export const resolveBaseBranchPolicy = (
  input: ResolveBaseBranchPolicyInput,
): readonly EffectiveBaseBranch[] => {
  const parsedOverrides = parseRepositoryBaseOverridesWithIssues(input.repositoryOverrides);
  const overrides = parsedOverrides.parsed;
  if (input.standalone && overrides.size > 0) {
    throw new BaseBranchPolicyError([
      {
        code: "STANDALONE_REPOSITORY_OVERRIDE",
        message:
          "--repo-base requires a configured workspace and is unavailable in standalone mode",
        value: [...overrides.keys()].join(","),
      },
    ]);
  }

  const explicitIdentities = input.selectedRepositories !== undefined;
  const selectedRepositories: readonly BaseBranchRepositoryIdentity[] =
    input.selectedRepositories ??
    (input.selectedRepositoryNames ?? []).map((repositoryName) => ({
      ...(repositoryName === input.metaRepositoryName ? {} : { configName: repositoryName }),
      identity: repositoryName === input.metaRepositoryName ? "@meta" : repositoryName,
      kind: repositoryName === input.metaRepositoryName ? "meta" : "child",
      repositoryName,
    }));
  const selected = new Set(selectedRepositories.map((repository) => repository.identity));
  const configured = new Set(Object.keys(input.config.repos));
  const issues: BaseBranchPolicyIssue[] = [...parsedOverrides.issues];
  for (const [selector, branch] of overrides) {
    if (selector === "@meta") {
      if (input.command === "clone") {
        issues.push({
          code: "META_NOT_ALLOWED",
          message: "@meta is not valid for clone because clone selects child repositories only",
          value: `${selector}=${branch}`,
        });
      } else if (!selected.has("@meta")) {
        issues.push({
          code: "UNSELECTED_REPOSITORY",
          message: "@meta does not identify a selected repository",
          value: `${selector}=${branch}`,
        });
      }
    } else if (!configured.has(selector)) {
      issues.push({
        code: "UNKNOWN_REPOSITORY",
        message: `Unknown configured repository selector '${selector}'`,
        value: `${selector}=${branch}`,
      });
    } else if (!selected.has(selector)) {
      issues.push({
        code: "UNSELECTED_REPOSITORY",
        message: `Repository selector '${selector}' is not selected`,
        value: `${selector}=${branch}`,
      });
    }
  }
  if (issues.length > 0) throw new BaseBranchPolicyError(issues);

  const normalizedGlobal = input.globalBase
    ? normalizeLogicalBranchName(input.globalBase)
    : undefined;
  if (
    input.command === "clone" &&
    normalizedGlobal &&
    !isValidRequestedBaseBranch(normalizedGlobal)
  ) {
    throw new BaseBranchPolicyError([
      {
        code: "INVALID_BRANCH",
        message: `'${input.globalBase}' is not a valid Git branch`,
        value: input.globalBase!,
      },
    ]);
  }

  return selectedRepositories.map((repository) => {
    const { repositoryName } = repository;
    const isMeta = repository.kind === "meta";
    const selector = repository.identity;
    const identity = explicitIdentities ? { repositoryIdentity: repository.identity } : {};
    const repositoryCli = overrides.get(selector);
    if (repositoryCli) {
      return {
        ...identity,
        repositoryName,
        requestedBranch: repositoryCli,
        source: "repository-cli",
      };
    }
    if (normalizedGlobal) {
      return { ...identity, repositoryName, requestedBranch: normalizedGlobal, source: "cli" };
    }
    const repositoryConfig = isMeta
      ? input.config.meta?.baseBranch
      : input.config.repos[repository.configName ?? repository.identity]?.baseBranch;
    if (repositoryConfig) {
      return {
        ...identity,
        repositoryName,
        requestedBranch: normalizeLogicalBranchName(repositoryConfig),
        source: "repository-config",
      };
    }
    if (input.config.baseBranch) {
      return {
        ...identity,
        repositoryName,
        requestedBranch: normalizeLogicalBranchName(input.config.baseBranch),
        source: "workspace-config",
      };
    }
    const legacy =
      input.command === "create" ? input.config.defaults?.create?.baseBranch : undefined;
    if (legacy) {
      return {
        ...identity,
        repositoryName,
        requestedBranch: normalizeLogicalBranchName(legacy),
        source: "workspace-config",
      };
    }
    return { ...identity, repositoryName, source: "legacy-omitted" };
  });
};

export const collectRepositoryBase = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

export const repositoryBaseOption = (description: string): Option => {
  const option = new Option("--repo-base <repository=branch>", description).argParser(
    collectRepositoryBase,
  );
  (option as Option & { repeatable?: boolean }).repeatable = true;
  return option;
};
