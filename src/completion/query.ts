import { basename, dirname, isAbsolute, resolve } from "node:path";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type {
  CliCommandContract,
  ContractCommand,
  ContractOption,
} from "../contracts/cli-commands.ts";
import type { CompletionCandidate, CompletionCandidateKind } from "./types.ts";

export const COMPLETION_QUERY_BUDGET_MS = 200;
const MAX_COMPLETION_CONFIG_BYTES = 1024 * 1024;

const optionSpellings = (option: ContractOption): string[] =>
  [option.short, option.long].filter((value): value is string => Boolean(value));

const prefixCandidates = (
  values: CompletionCandidate[],
  prefix: string,
  commaSegments = false,
): CompletionCandidate[] => {
  const comma = commaSegments ? prefix.lastIndexOf(",") : -1;
  const leading = comma < 0 ? "" : prefix.slice(0, comma + 1);
  const segment = comma < 0 ? prefix : prefix.slice(comma + 1);
  const normalized = segment.toLowerCase();
  return values
    .filter((candidate) => candidate.value.toLowerCase().startsWith(normalized))
    .map((candidate) => ({ ...candidate, value: `${leading}${candidate.value}` }))
    .toSorted((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
};

interface ParsedContext {
  command: ContractCommand | null;
  current: string;
  optionAssignment: string;
  endOfOptions: boolean;
  option: ContractOption | null;
  positionalIndex: number;
  wordsBeforeCursor: string[];
}

const activeArgument = (context: ParsedContext) => {
  const arguments_ = context.command?.arguments ?? [];
  return (
    arguments_[context.positionalIndex] ??
    (arguments_.at(-1)?.variadic ? arguments_.at(-1) : undefined)
  );
};

function parseContext(contract: CliCommandContract, argv: string[], cursor: number): ParsedContext {
  const words = argv.slice(0, Math.max(0, cursor + 1));
  let current = words[cursor] ?? "";
  const before = words.slice(1, cursor);
  let command: ContractCommand | null = null;
  let commandPath = "";
  let index = 0;

  while (index < before.length) {
    const word = before[index]!;
    if (word.startsWith("-")) break;
    const candidatePath = commandPath ? `${commandPath} ${word}` : word;
    const next = contract.commands.find(
      (item) =>
        !item.hidden && (item.path === candidatePath || item.aliasPaths.includes(candidatePath)),
    );
    if (!next) break;
    command = next;
    commandPath = next.path;
    index += 1;
  }

  const options = command?.options ?? contract.root.options;
  let endOfOptions = false;
  let positionalIndex = 0;
  let activeOption: ContractOption | null = null;
  let optionAssignment = "";
  for (; index < before.length; index += 1) {
    const word = before[index]!;
    if (word === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && word.startsWith("-")) {
      const spelling = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      const option = options.find((item) => optionSpellings(item).includes(spelling));
      if (option?.valueShape !== "boolean" && !word.includes("=")) index += 1;
      continue;
    }
    positionalIndex += 1;
  }

  if (!endOfOptions && before.length > 0) {
    const prior = before.at(-1)!;
    const spelling = prior.includes("=") ? prior.slice(0, prior.indexOf("=")) : prior;
    activeOption =
      options.find(
        (item) => item.valueShape !== "boolean" && optionSpellings(item).includes(spelling),
      ) ?? null;
  }

  if (!endOfOptions && current.startsWith("-") && current.includes("=")) {
    const equals = current.indexOf("=");
    const spelling = current.slice(0, equals);
    const inlineOption = options.find(
      (item) => item.valueShape !== "boolean" && optionSpellings(item).includes(spelling),
    );
    if (inlineOption) {
      activeOption = inlineOption;
      optionAssignment = current.slice(0, equals + 1);
      current = current.slice(equals + 1);
    }
  }

  return {
    command,
    current,
    endOfOptions,
    option: activeOption,
    optionAssignment,
    positionalIndex,
    wordsBeforeCursor: before,
  };
}

function staticCandidates(
  contract: CliCommandContract,
  context: ParsedContext,
): CompletionCandidate[] {
  if (context.option) {
    return prefixCandidates(
      (context.option.choices ?? []).map((value) => ({
        description: `Value for ${context.option!.long}`,
        value,
      })),
      context.current,
    );
  }

  const argument = activeArgument(context);
  if (argument?.choices?.length) {
    return prefixCandidates(
      argument.choices.map((value) => ({ description: argument.description, value })),
      context.current,
    );
  }

  const argumentCount = context.command?.arguments.length ?? 0;
  if (argument?.variadic && context.positionalIndex >= argumentCount) return [];

  const candidates: CompletionCandidate[] = [];
  const prefix = context.command?.path ?? "";
  for (const command of contract.commands) {
    if (command.hidden) continue;
    const parent = command.path.includes(" ")
      ? command.path.slice(0, command.path.lastIndexOf(" "))
      : "";
    if (parent === prefix) {
      candidates.push({ description: command.description, value: command.path.split(" ").at(-1)! });
      for (const alias of command.aliases)
        candidates.push({ description: command.description, value: alias });
    }
  }

  if (!context.endOfOptions) {
    const options = context.command?.options ?? contract.root.options;
    const present = new Set<string>();
    const blockedByPresentOptions = new Set<string>();
    for (const word of context.wordsBeforeCursor.filter((item) => item.startsWith("-"))) {
      const spelling = word.split("=")[0]!;
      present.add(spelling);
      const registered = options.find((option) => optionSpellings(option).includes(spelling));
      if (registered?.long) present.add(registered.long);
      for (const conflict of registered?.conflicts ?? []) blockedByPresentOptions.add(conflict);
    }
    for (const option of options) {
      const alreadyPresent = present.has(option.long) && !option.semanticPolicy?.selector;
      if (
        option.hidden ||
        alreadyPresent ||
        option.conflicts.some((conflict) => present.has(conflict)) ||
        optionSpellings(option).some((spelling) => blockedByPresentOptions.has(spelling))
      )
        continue;
      for (const value of optionSpellings(option))
        candidates.push({ description: option.description, value });
    }
  }
  return prefixCandidates(candidates, context.current);
}

interface WorkspaceData {
  configured: boolean;
  groups: string[];
  repositories: Array<{ name: string; path: string }>;
  root: string;
}

type CompletionConfig = { repos?: Record<string, { groups?: string[]; path: string }> };

function gitOutput(start: string, arguments_: string[], deadline: number): string | null {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return null;
  const result = spawnSync("git", ["-C", start, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: remaining,
  });
  if (result.status !== 0 || result.error || performance.now() >= deadline) return null;
  return result.stdout.trim();
}

function readCompletionConfig(configPath: string, deadline: number): CompletionConfig | null {
  let descriptor: number | undefined;
  try {
    if (performance.now() >= deadline) return null;
    descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_COMPLETION_CONFIG_BYTES) return null;
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as CompletionConfig;
    return performance.now() < deadline ? parsed : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function workspaceFromRoots(
  configurationRoot: string,
  executionRoot: string,
  deadline: number,
): WorkspaceData | null {
  const parsed = readCompletionConfig(
    resolve(configurationRoot, ".arashi", "config.json"),
    deadline,
  );
  if (!parsed) return null;
  const entries = Object.entries(parsed.repos ?? {});
  return {
    configured: true,
    groups: [...new Set(entries.flatMap(([, repository]) => repository.groups ?? []))],
    repositories: [
      { name: basename(configurationRoot), path: executionRoot },
      ...entries.map(([name, repository]) => ({
        name,
        path: resolve(executionRoot, repository.path),
      })),
    ],
    root: executionRoot,
  };
}

function configuredCommonRoot(
  start: string,
  deadline: number,
): { configurationRoot: string; executionRoot: string } | null {
  const checked = new Set<string>();
  let directory = resolve(start);
  while (performance.now() < deadline) {
    const rawCommon = gitOutput(directory, ["rev-parse", "--git-common-dir"], deadline);
    if (rawCommon) {
      const commonRoot = resolve(isAbsolute(rawCommon) ? rawCommon : resolve(directory, rawCommon));
      const configPath = resolve(commonRoot, ".arashi", "config.json");
      if (!checked.has(commonRoot) && existsSync(configPath)) {
        checked.add(commonRoot);
        const bare = gitOutput(directory, ["rev-parse", "--is-bare-repository"], deadline);
        const topLevel =
          bare === "true"
            ? commonRoot
            : gitOutput(directory, ["rev-parse", "--show-toplevel"], deadline);
        if (topLevel) return { configurationRoot: commonRoot, executionRoot: resolve(topLevel) };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function findWorkspace(start: string, deadline: number): WorkspaceData | null {
  let directory = resolve(start);
  while (performance.now() < deadline) {
    const configPath = resolve(directory, ".arashi", "config.json");
    if (existsSync(configPath)) return workspaceFromRoots(directory, directory, deadline);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  const configuredRoots = configuredCommonRoot(start, deadline);
  if (configuredRoots) {
    return workspaceFromRoots(
      configuredRoots.configurationRoot,
      configuredRoots.executionRoot,
      deadline,
    );
  }

  const root = gitOutput(start, ["rev-parse", "--show-toplevel"], deadline);
  return root
    ? {
        configured: false,
        groups: [],
        repositories: [{ name: basename(root), path: root }],
        root,
      }
    : null;
}

function worktreeCandidates(
  repositories: WorkspaceData["repositories"],
  formsFor: (repository: WorkspaceData["repositories"][number]) => {
    basename: boolean;
    branch: boolean;
    path: boolean;
  },
  excludePrimary: boolean,
  deadline: number,
): CompletionCandidate[] {
  const found = new Map<string, CompletionCandidate>();
  for (const repository of repositories) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return [];
    const result = spawnSync(
      "git",
      ["-C", repository.path, "worktree", "list", "--porcelain", "-z"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: remaining,
      },
    );
    if (result.status !== 0 || result.error) continue;
    let path = "";
    let branch = "";
    const add = () => {
      if (!path) return;
      if (excludePrimary && resolve(path) === resolve(repository.path)) return;
      const forms = formsFor(repository);
      const values = [
        forms.branch ? branch : "",
        forms.basename ? basename(path) : "",
        forms.path ? path : "",
      ];
      for (const value of values.filter(Boolean)) {
        found.set(value, {
          description: `${repository.name} worktree${branch ? ` (${branch})` : ""}`,
          value,
        });
      }
    };
    for (const line of result.stdout.split("\0")) {
      if (line === "") {
        add();
        path = "";
        branch = "";
      } else if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    add();
  }
  return [...found.values()];
}

function worktreeRepositories(
  workspace: WorkspaceData,
  context: ParsedContext,
): WorkspaceData["repositories"] {
  if (context.command?.path !== "switch") return workspace.repositories;
  if (context.wordsBeforeCursor.includes("--all")) return workspace.repositories;
  const parent = workspace.repositories.filter(
    (repository) => resolve(repository.path) === resolve(workspace.root),
  );
  const children = workspace.repositories.filter(
    (repository) => resolve(repository.path) !== resolve(workspace.root),
  );
  if (context.wordsBeforeCursor.includes("--repos")) return children;
  return parent.length > 0 ? parent : workspace.repositories.slice(0, 1);
}

function dynamicCandidates(
  kind: CompletionCandidateKind,
  contract: CliCommandContract,
  context: ParsedContext,
  cwd: string,
  deadline: number,
): CompletionCandidate[] {
  if (kind === "shell" || kind === "choice") return staticCandidates(contract, context);
  const workspace = findWorkspace(cwd, deadline);
  if (!workspace || performance.now() >= deadline) return [];
  if (kind === "repository") {
    if (!workspace.configured) return [];
    return prefixCandidates(
      workspace.repositories.map(({ name }) => ({
        description: "Configured repository",
        value: name,
      })),
      context.current,
      true,
    );
  }
  if (kind === "group") {
    if (!workspace.configured) return [];
    return prefixCandidates(
      workspace.groups.map((value) => ({ description: "Repository group", value })),
      context.current,
      true,
    );
  }
  const pathsOnly = kind === "worktree" && context.wordsBeforeCursor.includes("--path");
  const command = context.command?.path;
  const excludePrimary = command === "remove";
  const formsFor = (repository: WorkspaceData["repositories"][number]) => {
    if (pathsOnly) return { basename: false, branch: false, path: true };
    if (command === "move") {
      return {
        basename: resolve(repository.path) === resolve(workspace.root),
        branch: true,
        path: true,
      };
    }
    if (command === "remove") {
      return { basename: false, branch: true, path: workspace.configured };
    }
    return { basename: true, branch: true, path: true };
  };
  const candidates = worktreeCandidates(
    worktreeRepositories(workspace, context),
    formsFor,
    excludePrimary,
    deadline,
  );
  if (performance.now() >= deadline) return [];
  return prefixCandidates(candidates, context.current);
}

export function queryCompletionCandidates(
  contract: CliCommandContract,
  argv: string[],
  cursor: number,
  cwd = process.cwd(),
): CompletionCandidate[] {
  const deadline = performance.now() + COMPLETION_QUERY_BUDGET_MS;
  try {
    const context = parseContext(contract, argv, cursor);
    const completingOptionName =
      !context.endOfOptions && !context.option && context.current.startsWith("-");
    const owner = completingOptionName ? undefined : (context.option ?? activeArgument(context));
    const candidates = owner?.candidateKind
      ? dynamicCandidates(owner.candidateKind, contract, context, cwd, deadline)
      : staticCandidates(contract, context);
    return context.optionAssignment
      ? candidates.map((candidate) => ({
          ...candidate,
          value: `${context.optionAssignment}${candidate.value}`,
        }))
      : candidates;
  } catch {
    return [];
  }
}

export function encodeCompletionRecords(candidates: CompletionCandidate[]): Buffer {
  return Buffer.from(
    candidates.flatMap(({ value, description }) => [value, description]).join("\0") +
      (candidates.length ? "\0" : ""),
  );
}
