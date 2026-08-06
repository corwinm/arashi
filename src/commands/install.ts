import { createJsonSuccessEnvelope, writeJsonEnvelope } from "../lib/json-output.ts";
import { info, success } from "../lib/logger.ts";
import { Command } from "commander";

export const INSTALL_COMMAND_DESCRIPTION = "Install the npm-managed Arashi platform binary";

export function createCommand(): Command {
  return new Command("install")
    .description(INSTALL_COMMAND_DESCRIPTION)
    .option("-j, --json", "Output result as JSON")
    .action((options: { json?: boolean }) => {
      const message = "No npm-managed binary installation is needed in this direct binary context.";
      const npmEntrypointMessage =
        "The npm package entrypoint handles `arashi install` before the native binary starts.";
      const reinstallMessage =
        "For direct binary or curl installs, reinstall Arashi or download a release asset if the binary is missing.";
      const releasesUrl = "https://github.com/corwinm/arashi/releases";

      if (options.json) {
        writeJsonEnvelope(
          createJsonSuccessEnvelope("install", {
            message,
            npmEntrypointMessage,
            reinstallMessage,
            releasesUrl,
          }),
        );
        return;
      }

      success(message);
      info(npmEntrypointMessage);
      info(reinstallMessage);
      info(`Manual releases: ${releasesUrl}`);
    });
}
