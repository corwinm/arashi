import {
  SUPPORTED_SHELLS,
  buildShellInitScript,
  installShellIntegration,
  isSupportedShell,
  planDetectedShellUninstalls,
  applyShellUninstall,
  type ShellUninstallPlan,
} from "../lib/shell-integration.ts";
import { confirm as promptConfirm, type PromptOutcome } from "../lib/prompts.ts";
import { info, error as logError, success } from "../lib/logger.ts";
import { unsupportedJsonModeError, writeJsonEnvelope } from "../lib/json-output.ts";
import { Argument, Command } from "commander";

const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;

export function createCommand(): Command {
  const shellCommand = new Command("shell").description(
    "Manage shell integration for parent-shell switching",
  );

  shellCommand
    .command("init")
    .description("Print shell wrapper code")
    .addArgument(
      new Argument("[shell]", `Shell name (${SUPPORTED_SHELLS.join(", ")})`)
        .choices([...SUPPORTED_SHELLS])
        .argParser((value) => value.trim().toLowerCase()),
    )
    .option("-j, --json", "Return a structured unsupported-mode error instead of shell code")
    .action((shellName: string | undefined, options: { json?: boolean }) => {
      try {
        if (options.json) {
          writeJsonEnvelope(unsupportedJsonModeError("shell", "init"));
          process.exit(USAGE_EXIT_CODE);
        }
        if (!shellName) {
          throw new Error(
            `Missing required shell. Supported shells: ${SUPPORTED_SHELLS.join(", ")}.`,
          );
        }
        process.stdout.write(executeShellInit(shellName));
        process.exit(0);
      } catch (error) {
        handleShellCommandError(error);
      }
    });

  shellCommand
    .command("uninstall")
    .description("Remove exact managed shell integration")
    .option("-n, --dry-run", "Inspect the shell removal plan without changing anything")
    .option("-y, --yes", "Apply the completely preflighted shell removal plan")
    .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
      try {
        await executeShellUninstall(options);
        process.exit(0);
      } catch (error) {
        handleShellCommandError(error);
      }
    });

  shellCommand
    .command("install")
    .description("Install shell integration into the active shell startup file")
    .action(async () => {
      try {
        const result = await executeShellInstall();
        success(
          `Installed Arashi shell integration for ${result.shell} in ${result.startupFilePath}`,
        );
        info("Restart your shell or source the startup file to enable switching and completion.");
        process.exit(0);
      } catch (error) {
        handleShellCommandError(error);
      }
    });

  return shellCommand;
}

export function executeShellInit(shellName: string): string {
  const normalizedShell = shellName.trim().toLowerCase();
  if (!isSupportedShell(normalizedShell)) {
    throw new Error(
      `Unsupported shell \`${shellName}\`. Supported shells: ${SUPPORTED_SHELLS.join(", ")}.`,
    );
  }

  return buildShellInitScript(normalizedShell);
}

export async function executeShellInstall() {
  return await installShellIntegration();
}

export async function executeShellUninstall(
  options: { dryRun?: boolean; yes?: boolean },
  dependencies: {
    apply?: (plan: ShellUninstallPlan) => Promise<void>;
    confirm?: (message: string, defaultValue: boolean) => Promise<PromptOutcome<boolean>>;
    interactive?: boolean;
    plan?: () => Promise<ShellUninstallPlan[]>;
    write?: (line: string) => void;
  } = {},
): Promise<"absent" | "applied" | "declined" | "dry-run"> {
  const plans = await (dependencies.plan ?? planDetectedShellUninstalls)();
  const write = dependencies.write ?? console.log;
  const removable = plans.filter((plan) => plan.status === "removable");
  if (plans.length === 0) {
    write("No managed Arashi shell block exists in the deterministic startup files.");
  } else {
    for (const plan of plans) {
      write(
        plan.status === "removable"
          ? `Remove the exact managed Arashi shell block from ${plan.startupFilePath}.`
          : `Preserve shell startup candidate ${plan.startupFilePath}: ${plan.diagnostic ?? "unsafe target"}.`,
      );
    }
  }
  if (options.dryRun) return "dry-run";
  if (removable.length === 0) return "absent";
  if (!options.yes) {
    const interactive =
      dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) throw new Error("Non-interactive shell uninstall requires --yes.");
    const outcome = await (dependencies.confirm ?? promptConfirm)(
      "Remove shell integration?",
      false,
    );
    if (outcome.status !== "ok" || !outcome.value) return "declined";
  }
  for (const plan of removable) await (dependencies.apply ?? applyShellUninstall)(plan);
  return "applied";
}

function handleShellCommandError(error: unknown): never {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof Error ? USAGE_EXIT_CODE : ERROR_EXIT_CODE);
}
