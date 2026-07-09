import { Command } from "commander";
import chalk from "chalk";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import {
  runDoctor,
  type DoctorFinding,
  type DoctorResult,
  type DoctorSeverity,
} from "../lib/doctor.ts";

const ZERO = 0;
const ERROR_EXIT_CODE = 1;

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
  const lines: string[] = [];
  lines.push(chalk.bold("Arashi workspace doctor"));
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
  const result = await runDoctor();
  const hasBlockingFindings = result.summary.error > ZERO;

  if (options.json) {
    if (hasBlockingFindings) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("doctor", {
          code: "DOCTOR_BLOCKING_FINDINGS",
          details: result as unknown as Record<string, unknown>,
          message: `${result.summary.error} blocking doctor finding(s) detected`,
        }),
      );
    } else {
      writeJsonEnvelope(
        createJsonSuccessEnvelope("doctor", result as unknown as Record<string, unknown>),
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
