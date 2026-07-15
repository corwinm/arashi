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
import {
  repositoryStatusToDoctorFindings,
  runDoctor,
  summarizeDoctorFindings,
} from "../lib/doctor.ts";
import { checkRepoStatus } from "./status.ts";
import { discoverPrunableWorktrees } from "../core/remove.ts";

const ZERO = 0;
const ERROR_EXIT_CODE = 1;

type DoctorResult = Awaited<ReturnType<typeof runDoctor>>;
type DoctorFinding = DoctorResult["findings"][number];
type DoctorSeverity = DoctorFinding["severity"];

export interface DoctorOptions {
  json?: boolean;
}

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

export const executeDoctor = async (options: DoctorOptions = {}): Promise<number> => {
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
    let ignored = true;
    try {
      await exec(
        ["check-ignore", "--no-index", ".worktrees/.arashi-ignore-probe"],
        context.mainRoot,
      );
    } catch {
      ignored = false;
    }
    const repositoryStatus = await checkRepoStatus(context.repository.name, context.mainRoot);
    const pruneResults = await discoverPrunableWorktrees([context.repository]);
    const findings = [
      ...(!ignored
        ? [
            {
              category: "configuration" as const,
              code: "STANDALONE_WORKTREES_NOT_IGNORED",
              message: ".worktrees is not effectively ignored",
              scope: context.mainRoot,
              severity: "warning" as const,
              suggestedCommands: ["arashi init --zero-config"],
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
          suggestedCommands: ["arashi prune --dry-run", "arashi prune"],
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
    if (options.json) writeJsonEnvelope(createJsonSuccessEnvelope("doctor", data));
    else
      console.log(
        `Arashi workspace doctor\nWorkspace mode: standalone\nWorkspace: ${context.mainRoot}\n${findings.length ? findings.map((finding) => finding.message).join("\n") : "No workspace health findings were detected."}`,
      );
    return ZERO;
  }
  const result = await runDoctor();
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
    .option("--json", "Output a structured JSON envelope")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi doctor          # Human-readable workspace health check
  $ arashi doctor --json   # Automation-safe JSON diagnostics
      `,
    )
    .action(async (options: DoctorOptions) => {
      const exitCode = await executeDoctor(options);
      process.exit(exitCode);
    });
