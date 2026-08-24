import { createHash } from "node:crypto";
import { copyFile, chmod, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";

import { confirm as promptConfirm, type PromptOutcome } from "../lib/prompts.ts";
import { planDirectUninstall, type DirectUninstallPlan } from "../lib/uninstall-manifest.ts";
import { error as logError } from "../lib/logger.ts";
import { planSupportedShellUninstalls, type ShellUninstallPlan } from "../lib/shell-integration.ts";

export interface UninstallOptions {
  dryRun?: boolean;
  yes?: boolean;
}

type DirectDependencies = {
  apply?: (plan: DirectUninstallPlan) => Promise<void>;
  confirm?: (message: string, defaultValue: boolean) => Promise<PromptOutcome<boolean>>;
  execPath?: string;
  installDirectory?: string;
  interactive?: boolean;
  plan?: (installDirectory: string) => Promise<DirectUninstallPlan>;
  shellPlan?: () => Promise<ShellUninstallPlan>;
  write?: (line: string) => void;
};

export function renderDirectUninstallPlan(plan: DirectUninstallPlan): string {
  const lines = [
    "Installation channel: official-direct",
    `Install directory: ${plan.installDirectory}`,
    "Actions:",
    ...plan.files.map(
      (file) => `- ${file.status === "absent" ? "already absent" : "remove"}: ${file.relativePath}`,
    ),
  ];
  if (plan.pathMutation) lines.push(`- PATH state: ${plan.pathMutation.status}`);
  lines.push(
    "Preserved: workspaces, repositories, worktrees, project files, .arashi.yaml, Git metadata, configuration, unrelated profile bytes, and unrelated install-directory files.",
  );
  return lines.join("\n");
}

export async function stageDirectUninstallHelper(
  plan: DirectUninstallPlan,
  dependencies: {
    chmod?: (path: string, mode: number) => Promise<void>;
    copyFile?: (source: string, destination: string) => Promise<void>;
    mkdtemp?: (prefix: string) => Promise<string>;
    parentPid?: number;
    readFile?: (path: string) => Promise<Buffer>;
    spawn?: (
      command: string,
      args: string[],
      options: { detached: true; stdio: "inherit" },
    ) => { unref(): void };
  } = {},
): Promise<void> {
  const helper = plan.files.find((file) => file.role === "uninstall-helper");
  if (!helper || helper.status !== "removable") {
    throw new Error(
      "The manifest-owned uninstall helper is unavailable; refresh this install first.",
    );
  }
  const temporaryDirectory = await (dependencies.mkdtemp ?? mkdtemp)(
    join(tmpdir(), "arashi-uninstall-"),
  );
  const suffix = plan.manifest.platform === "windows" ? ".ps1" : ".sh";
  const temporaryHelper = join(temporaryDirectory, `uninstall${suffix}`);
  await (dependencies.copyFile ?? copyFile)(helper.absolutePath, temporaryHelper);
  if (plan.manifest.platform === "posix")
    await (dependencies.chmod ?? chmod)(temporaryHelper, 0o700);
  const stagedDigest = createHash("sha256")
    .update(await (dependencies.readFile ?? readFile)(temporaryHelper))
    .digest("hex");
  if (stagedDigest !== helper.digest) {
    throw new Error("The staged uninstall helper does not match its manifest digest.");
  }
  const spawnHelper = dependencies.spawn ?? spawn;
  const parentPid = String(dependencies.parentPid ?? process.pid);
  const child =
    plan.manifest.platform === "windows"
      ? spawnHelper(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            temporaryHelper,
            "-InstallDir",
            plan.manifest.installDirectory,
            "-ParentPid",
            parentPid,
            "-Yes",
            "-TemporarySelf",
          ],
          { detached: true, stdio: "inherit" },
        )
      : spawnHelper(
          temporaryHelper,
          [
            "--install-dir",
            plan.manifest.installDirectory,
            "--parent-pid",
            parentPid,
            "--yes",
            "--temporary-self",
          ],
          {
            detached: true,
            stdio: "inherit",
          },
        );
  child.unref();
}

export async function executeDirectUninstall(
  options: UninstallOptions,
  dependencies: DirectDependencies = {},
): Promise<"applied" | "declined" | "dry-run"> {
  const environmentDirectory = process.env.ARASHI_INSTALL_DIR?.trim();
  const installDirectory =
    dependencies.installDirectory ??
    (environmentDirectory || dirname(dependencies.execPath ?? process.execPath));
  const plan = await (dependencies.plan ?? planDirectUninstall)(installDirectory);
  let shellPlans: ShellUninstallPlan[] = [];
  try {
    shellPlans = dependencies.shellPlan
      ? [await dependencies.shellPlan()]
      : await planSupportedShellUninstalls();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Unable to detect a supported shell")
    ) {
      throw error;
    }
  }
  const write = dependencies.write ?? console.log;
  write(renderDirectUninstallPlan(plan));
  if (shellPlans.length === 0) {
    write("Shell integration: inspect deterministic supported startup files in the helper.");
  } else {
    for (const shellPlan of shellPlans) {
      write(
        shellPlan.status === "removable"
          ? `Shell integration: remove exact managed block from ${shellPlan.startupFilePath}`
          : `Shell integration: no managed block in ${shellPlan.startupFilePath}`,
      );
    }
  }
  if (options.dryRun) return "dry-run";

  if (!options.yes) {
    const interactive =
      dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) throw new Error("Non-interactive uninstall requires --yes.");
    const outcome = await (dependencies.confirm ?? promptConfirm)(
      "Remove this Arashi installation?",
      false,
    );
    if (outcome.status !== "ok" || !outcome.value) return "declined";
  }
  await (dependencies.apply ?? stageDirectUninstallHelper)(plan);
  return "applied";
}

export function createCommand(): Command {
  return new Command("uninstall")
    .description("Conservatively remove a proven Arashi installation")
    .option("-n, --dry-run", "Inspect the uninstall plan without changing anything")
    .option("-y, --yes", "Apply the completely preflighted uninstall plan")
    .action(async (options: UninstallOptions) => {
      try {
        await executeDirectUninstall(options);
        process.exit(0);
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
