import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { Command } from "commander";
import { resolveWorkspaceContext } from "../lib/workspace-context.ts";
import { exec } from "../lib/git.ts";
import chalk from "chalk";
import { resolve } from "path";
import { standaloneIgnoreLayout } from "../lib/worktree-location.ts";
import { parseGitIgnoreVerbose } from "../lib/git-ignore.ts";
import {
  repositoryStatusToDoctorFindings,
  runDoctor,
  summarizeDoctorFindings,
} from "../lib/doctor.ts";
import { checkRepoStatus } from "./status.ts";
import { discoverPrunableWorktrees } from "../core/remove.ts";
import { collectT3ReadinessOutcome } from "../lib/t3-readiness.ts";
import { formatT3ReadinessOutput } from "../lib/t3-readiness-output.ts";

const ZERO = 0;
const ERROR_EXIT_CODE = 1;

type DoctorResult = Awaited<ReturnType<typeof runDoctor>>;
type DoctorFinding = DoctorResult["findings"][number];
type DoctorSeverity = DoctorFinding["severity"];

export interface DoctorOptions {
  json?: boolean;
  t3?: boolean;
  t3Authenticated?: boolean;
  path?: string;
  t3Cli?: string;
  t3BaseDir?: string;
  t3Provider?: string;
  t3Model?: string;
  t3Effort?: string;
}

const t3OnlyOptions = [
  "t3Authenticated",
  "path",
  "t3Cli",
  "t3BaseDir",
  "t3Provider",
  "t3Model",
  "t3Effort",
] as const;
const invalidT3Options = (options: DoctorOptions): boolean =>
  options.t3 !== true && t3OnlyOptions.some((key) => options[key] !== undefined);
const t3ModeRequired = "T3-only options require --t3.";

const severityLabel = (severity: DoctorSeverity): string => {
  if (severity === "error") {
    return chalk.red("BLOCKING");
  }
  if (severity === "warning") {
    return chalk.yellow("WARNING");
  }
  return chalk.cyan("INFO");
};

const severityHeading = (severity: DoctorSeverity): string => {
  if (severity === "error") {
    return "Blocking findings";
  }
  if (severity === "warning") {
    return "Warnings";
  }
  return "Information";
};

const groupBySeverity = (findings: DoctorFinding[]): Record<DoctorSeverity, DoctorFinding[]> => ({
  error: findings.filter((finding) => finding.severity === "error"),
  info: findings.filter((finding) => finding.severity === "info"),
  warning: findings.filter((finding) => finding.severity === "warning"),
});

export const formatDoctorHumanOutput = (result: DoctorResult): string => {
  const lines: string[] = [chalk.bold("Arashi workspace doctor")];
  if (result.workspaceRoot) {
    lines.push(`Workspace: ${result.workspaceRoot}`);
  }
  lines.push(
    `Summary: ${result.summary.error} blocking, ${result.summary.warning} warning, ${result.summary.info} info (${result.summary.total} total)`,
  );

  if (result.findings.length === ZERO) {
    lines.push("");
    lines.push(chalk.green("✓ No workspace health findings were detected."));
    return lines.join("\n");
  }

  const grouped = groupBySeverity(result.findings);
  for (const severity of ["error", "warning", "info"] as const) {
    const findings = grouped[severity];
    if (findings.length === ZERO) {
      continue;
    }
    lines.push("");
    lines.push(chalk.bold(severityHeading(severity)));
    for (const finding of findings) {
      lines.push(`  ${severityLabel(finding.severity)} ${finding.code} [${finding.scope}]`);
      lines.push(`    ${finding.message}`);
      if (finding.suggestedCommands.length > ZERO) {
        lines.push("    Suggested commands:");
        for (const command of finding.suggestedCommands) {
          lines.push(`      - ${command}`);
        }
      }
    }
  }

  return lines.join("\n");
};

export const executeDoctor = async (
  options: DoctorOptions = {},
  ...unexpectedArguments: unknown[]
): Promise<number> => {
  if (invalidT3Options(options) || unexpectedArguments.length > ZERO) {
    const message =
      unexpectedArguments.length > ZERO
        ? "Doctor does not accept positional arguments."
        : t3ModeRequired;
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("doctor", {
          code: "INVALID_OPTIONS",
          message,
        }),
      );
    } else {
      console.error(message);
    }
    return ERROR_EXIT_CODE;
  }
  if (options.t3 === true) {
    // The collector owns read-only context discovery and screens context failures.
    // It also owns authenticated cancellation/finally cleanup; never exit inside it.
    const outcome = await collectT3ReadinessOutcome({
      authenticated: options.t3Authenticated === true,
      cwd: process.cwd(),
      explicitSettings: {
        ...(options.t3Cli === undefined ? {} : { cli: options.t3Cli }),
        ...(options.t3BaseDir === undefined ? {} : { baseDir: options.t3BaseDir }),
        ...(options.t3Provider === undefined ? {} : { provider: options.t3Provider }),
        ...(options.t3Model === undefined ? {} : { model: options.t3Model }),
        ...(options.t3Effort === undefined ? {} : { effort: options.t3Effort }),
      },
      path: options.path,
    });
    const output = formatT3ReadinessOutput(outcome, options.json === true);
    process.stdout.write(`${output.text}\n`);
    return output.exitCode;
  }
  let context;
  try {
    context = await resolveWorkspaceContext();
  } catch (error) {
    const converted = unknownErrorToJsonError(error, "CONFIG_LOAD_FAILED");
    const finding = {
      category: "configuration" as const,
      code: "CONFIG_LOAD_FAILED",
      details: converted.details,
      message: converted.message,
      scope: process.cwd(),
      severity: "error" as const,
      suggestedCommands: [],
    };
    const details = {
      checkedCategories: ["configuration"] as const,
      findings: [finding],
      summary: summarizeDoctorFindings([finding]),
    };
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("doctor", {
          code: "DOCTOR_BLOCKING_FINDINGS",
          details,
          message: `1 blocking doctor finding(s) detected: ${converted.message}`,
        }),
      );
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return ERROR_EXIT_CODE;
  }
  if (context?.mode === "standalone") {
    const worktreesBase =
      context.effective?.worktreesBase ??
      resolve(context.mainRoot, context.config.worktreesDir ?? ".worktrees");
    const layout = standaloneIgnoreLayout(context.mainRoot, worktreesBase);
    let ignored = true;
    if (layout.applicable) {
      try {
        const result = await exec(
          ["check-ignore", "--no-index", "-v", layout.probe],
          context.mainRoot,
        );
        ignored = parseGitIgnoreVerbose(result.stdout).ignored;
      } catch {
        ignored = false;
      }
    }
    const repositoryStatus = await checkRepoStatus(context.repository.name, context.mainRoot);
    const pruneResults = await discoverPrunableWorktrees([context.repository]);
    const findings = [
      ...(!ignored
        ? [
            {
              category: "configuration" as const,
              code: "STANDALONE_WORKTREES_NOT_IGNORED",
              message: `${worktreesBase} is not effectively ignored`,
              scope: context.mainRoot,
              severity: "warning" as const,
              suggestedCommands: ["aw init --zero-config"],
            },
          ]
        : []),
      ...repositoryStatusToDoctorFindings(repositoryStatus),
      ...pruneResults.flatMap((repository) =>
        repository.prunable.map((worktree) => ({
          category: "worktree" as const,
          code: "WORKTREE_STALE_METADATA",
          details: {
            path: worktree.path,
            pruneReason: worktree.pruneReason,
            repository: repository.name,
          },
          message: `Repository '${repository.name}' has stale worktree metadata for ${worktree.path}.`,
          scope: `repository:${repository.name}`,
          severity: "warning" as const,
          suggestedCommands: ["aw prune --dry-run", "aw prune"],
        })),
      ),
    ];
    const data = {
      checkedCategories: ["workspace", "repository", "worktree"] as const,
      findings,
      mode: "standalone",
      repositoryPath: context.mainRoot,
      summary: summarizeDoctorFindings(findings),
      workspaceRoot: context.mainRoot,
    };
    const hasBlockingFindings = data.summary.error > ZERO;
    if (options.json) {
      if (hasBlockingFindings) {
        writeJsonEnvelope(
          createJsonErrorEnvelope("doctor", {
            code: "DOCTOR_BLOCKING_FINDINGS",
            details: data,
            message: `${data.summary.error} blocking doctor finding(s) detected`,
          }),
        );
      } else {
        writeJsonEnvelope(createJsonSuccessEnvelope("doctor", data));
      }
    } else {
      console.log(
        `Workspace mode: standalone\n${formatDoctorHumanOutput({
          checkedCategories: [...data.checkedCategories],
          findings,
          summary: data.summary,
          workspaceRoot: context.mainRoot,
        })}`,
      );
    }
    return hasBlockingFindings ? ERROR_EXIT_CODE : ZERO;
  }
  const result = await runDoctor(
    process.platform,
    context.mode === "configured"
      ? {
          config: context.config,
          personalWorktreesDir: context.effective?.sources.worktreesDir === "user",
        }
      : {},
  );
  const hasBlockingFindings = result.summary.error > ZERO;
  const configuredData = {
    ...result,
    mode: "configured" as const,
    worktreesBase:
      context.mode === "configured"
        ? resolve(context.workspaceRoot, context.config.worktreesDir ?? "../.worktrees")
        : undefined,
  };

  if (options.json) {
    if (hasBlockingFindings) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("doctor", {
          code: "DOCTOR_BLOCKING_FINDINGS",
          details: configuredData as unknown as Record<string, unknown>,
          message: `${result.summary.error} blocking doctor finding(s) detected`,
        }),
      );
    } else {
      writeJsonEnvelope(
        createJsonSuccessEnvelope("doctor", configuredData as unknown as Record<string, unknown>),
      );
    }
  } else {
    console.log(formatDoctorHumanOutput(result));
  }

  return hasBlockingFindings ? ERROR_EXIT_CODE : ZERO;
};

export const createCommand = (): Command =>
  new Command("doctor")
    .description("Run non-mutating Arashi workspace diagnostics")
    .option("-j, --json", "Output a structured JSON envelope")
    .option("--t3", "Check T3 prerequisites only (preview by default)")
    .option(
      "--t3-authenticated",
      "Explicitly allow administrative authentication for bounded T3 reads",
    )
    .option(
      "--path <existing-checkout>",
      "Select one existing registered Git checkout for T3 diagnostics",
    )
    .option("--t3-cli <executable>", "T3 executable command or absolute path")
    .option("--t3-base-dir <absolute-directory>", "Selected T3 profile directory")
    .option("--t3-provider <instance-or-unambiguous-driver>", "T3 provider selection")
    .option("--t3-model <slug-or-alias>", "T3 model selection")
    .option("--t3-effort <catalog-value>", "T3 catalog effort selection")
    .allowExcessArguments(false)
    .addHelpText(
      "after",
      `
Examples:
  $ aw doctor          # Human-readable workspace health check
  $ aw doctor --json   # Automation-safe JSON diagnostics
      `,
    )
    .action(async (options: DoctorOptions) => {
      const exitCode = await executeDoctor(options);
      process.exit(exitCode);
    });
