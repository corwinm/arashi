const ORIGIN_PREFIX = "origin/";

/**
 * The Git branch-name syntax that JSON Schema can represent synchronously.
 * Operational resolvers still use `git check-ref-format --branch` as the authority.
 */
export const GIT_BRANCH_NAME_PATTERN = String.raw`^(?!HEAD$)(?![-/.])(?!.*(?:/\.|//|\.\.|@\{))(?!.*\.lock(?:/|$))(?!.*[/.]$)[^\u0000-\u0020\u007F~^:?*\[\\]+$`;

const GIT_BRANCH_NAME_REGEX = new RegExp(GIT_BRANCH_NAME_PATTERN);

/** Strip at most one remote shorthand prefix to obtain the logical branch name. */
export const normalizeLogicalBranchName = (branchName: string): string =>
  branchName.startsWith(ORIGIN_PREFIX) ? branchName.slice(ORIGIN_PREFIX.length) : branchName;

/** Validate the literal branch name without interpreting remote shorthand. */
export const isValidGitBranchNameLiteral = (branchName: string): boolean =>
  GIT_BRANCH_NAME_REGEX.test(branchName);

/** Validate a requested base after interpreting one remote shorthand prefix. */
export const isValidRequestedBaseBranch = (branchName: string): boolean =>
  isValidGitBranchNameLiteral(normalizeLogicalBranchName(branchName));
