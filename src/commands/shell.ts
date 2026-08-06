import {
  SUPPORTED_SHELLS,
  buildShellInitScript,
  installShellIntegration,
  isSupportedShell,
} from "../lib/shell-integration.ts";
import { info, error as logError, success } from "../lib/logger.ts";
import { unsupportedJsonModeError, writeJsonEnvelope } from "../lib/json-output.ts";
import { Command } from "commander";

const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;

export function createCommand(): Command {
  const shellCommand = new Command("shell").description(
    "Manage shell integration for parent-shell switching",
  );

  shellCommand
    .command("init")
    .description("Print shell wrapper code")
    .argument("[shell]", `Shell name (${SUPPORTED_SHELLS.join(", ")})`)
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
    .command("install")
    .description("Install shell integration into the active shell startup file")
    .action(async () => {
      try {
        const result = await executeShellInstall();
        success(
          `Installed Arashi shell integration for ${result.shell} in ${result.startupFilePath}`,
        );
        info("Restart your shell or source the startup file to enable parent-shell switching.");
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

function handleShellCommandError(error: unknown): never {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof Error ? USAGE_EXIT_CODE : ERROR_EXIT_CODE);
}
