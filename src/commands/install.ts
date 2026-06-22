import { info, success } from "../lib/logger.ts";
import { Command } from "commander";

export const INSTALL_COMMAND_DESCRIPTION = "Install the npm-managed Arashi platform binary";

export function createCommand(): Command {
  return new Command("install").description(INSTALL_COMMAND_DESCRIPTION).action(() => {
    success("No npm-managed binary installation is needed in this direct binary context.");
    info("The npm package entrypoint handles `arashi install` before the native binary starts.");
    info(
      "For direct binary or curl installs, reinstall Arashi or download a release asset if the binary is missing.",
    );
    info("Manual releases: https://github.com/corwinm/arashi/releases");
  });
}
