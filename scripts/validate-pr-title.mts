import { pathToFileURL } from "node:url";

export const SUPPORTED_TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

export type PullRequestTitleValidation = { valid: true } | { message: string; valid: false };

const titlePattern = new RegExp(
  `^(?:${SUPPORTED_TYPES.join("|")})(?:\\([^()\\r\\n\\u2028\\u2029]+\\))?!?: (?!\\s*$)[^\\r\\n\\u2028\\u2029]+$`,
);

export function validatePullRequestTitle(title: string): PullRequestTitleValidation {
  if (titlePattern.test(title)) {
    return { valid: true };
  }

  return {
    message: [
      "Pull request title must use Conventional Commit syntax:",
      "  <type>[optional scope][optional !]: <subject>",
      `Recognized types: ${SUPPORTED_TYPES.join(", ")}`,
      "Example: fix: clarify switch success output",
    ].join("\n"),
    valid: false,
  };
}

function main(): number {
  const title = process.env.PR_TITLE ?? "";
  const result = validatePullRequestTitle(title);

  if (result.valid) {
    console.log(`Valid pull request title: ${title}`);
    return 0;
  }

  console.error(result.message);
  console.error(`Received: ${JSON.stringify(title)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
