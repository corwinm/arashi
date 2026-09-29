import { Command, Option } from "commander";
import { isAbsolute, resolve } from "path";
import { CURRENT_CONFIG_VERSION } from "../lib/config.ts";
import { createJsonSuccessEnvelope, writeJsonEnvelope } from "../lib/json-output.ts";
import {
  resolveGitMainWorktree,
  resolveWorkspaceContext,
  type ConfiguredWorkspaceContext,
  type StandaloneWorkspaceContext,
} from "../lib/workspace-context.ts";
import {
  resolveEffectivePersonalConfig,
  type EffectiveConfigSource,
  type EffectivePersonalConfig,
} from "../lib/user-config.ts";

interface EffectiveOptions {
  createLaunch?: "none" | "auto" | "sesh" | "herdr";
  createSwitch?: boolean;
  json?: boolean;
  switchMode?: "auto" | "cd" | "launch" | "sesh" | "herdr";
  worktreesDir?: string;
}

interface EffectiveEntry {
  source: EffectiveConfigSource;
  value: unknown;
}

const inspectableEntries = (effective: EffectivePersonalConfig): Record<string, EffectiveEntry> => {
  const config = effective.config;
  const values: Record<string, unknown> = {
    "defaults.create.switch": config.defaults?.create?.switch ?? false,
    "defaults.create.launch": config.defaults?.create?.launch ?? "none",
    "defaults.switch.mode": config.defaults?.switch?.mode ?? "launch",
    worktreesDir: effective.worktreesBase,
    "worktreeNaming.style": config.worktreeNaming?.style ?? "default",
    "worktreeNaming.branchSlashes": config.worktreeNaming?.branchSlashes ?? "preserve",
    "worktreeNaming.maxPathLength": config.worktreeNaming?.maxPathLength ?? null,
  };
  for (const host of ["vscode", "cursor", "kiro"] as const) {
    values[`defaults.editors.${host}.create.switch`] =
      config.defaults?.editors?.[host]?.create?.switch ?? null;
    values[`defaults.editors.${host}.create.launch`] =
      config.defaults?.editors?.[host]?.create?.launch ?? null;
  }
  return Object.fromEntries(
    Object.entries(values).map(([field, value]) => [
      field,
      { source: effective.sources[field] ?? "built-in", value },
    ]),
  );
};

const effectiveWithoutBootstrap = async (): Promise<{
  context: ConfiguredWorkspaceContext | StandaloneWorkspaceContext;
  effective: EffectivePersonalConfig;
}> => {
  const context = await resolveWorkspaceContext();
  if (context.mode !== "unavailable" && context.effective) {
    return { context, effective: context.effective };
  }
  const mainRoot = await resolveGitMainWorktree(process.cwd(), { strict: true });
  if (!mainRoot) throw new Error("Effective configuration requires a non-bare Git repository.");
  const effective = await resolveEffectivePersonalConfig({
    builtInWorktreesDir: ".worktrees",
    mainRoot,
    workspaceConfig: {
      repos: {},
      reposDir: "./repos",
      version: CURRENT_CONFIG_VERSION,
      worktreesDir: ".worktrees",
    },
    workspaceConfigPath: null,
    workspaceWorktreesDirAuthored: false,
  });
  return {
    context: {
      config: effective.config,
      effective,
      invocationPath: resolve(process.cwd()),
      mainRoot,
      mode: "standalone",
      repository: { name: mainRoot.split(/[\\/]/).at(-1) ?? "repository", path: mainRoot },
      workspaceRoot: mainRoot,
    },
    effective,
  };
};

const applyCliInspectionOverrides = (
  effective: EffectivePersonalConfig,
  options: EffectiveOptions,
): EffectivePersonalConfig => {
  const config = structuredClone(effective.config);
  const sources = { ...effective.sources };
  if (options.createSwitch !== undefined) {
    config.defaults ??= {};
    config.defaults.create ??= {};
    config.defaults.create.switch = options.createSwitch;
    sources["defaults.create.switch"] = "cli";
  }
  if (options.createLaunch !== undefined) {
    config.defaults ??= {};
    config.defaults.create ??= {};
    config.defaults.create.launch = options.createLaunch;
    sources["defaults.create.launch"] = "cli";
  }
  if (options.switchMode !== undefined) {
    config.defaults ??= {};
    config.defaults.switch ??= {};
    config.defaults.switch.mode = options.switchMode;
    sources["defaults.switch.mode"] = "cli";
  }
  let worktreesBase = effective.worktreesBase;
  if (options.worktreesDir !== undefined) {
    worktreesBase = isAbsolute(options.worktreesDir)
      ? resolve(options.worktreesDir)
      : resolve(effective.mainRoot, options.worktreesDir);
    config.worktreesDir = worktreesBase;
    sources.worktreesDir = "cli";
  }
  return { ...effective, config, sources, worktreesBase };
};

const createEffectiveCommand = (): Command =>
  new Command("effective")
    .description("Inspect effective personal settings and their provenance")
    .option("--create-switch", "Inspect with create switching explicitly enabled")
    .option("--no-create-switch", "Inspect with create switching explicitly disabled")
    .addOption(
      new Option("--create-launch <mode>", "Inspect with an explicit create launcher").choices([
        "none",
        "auto",
        "sesh",
        "herdr",
      ]),
    )
    .addOption(
      new Option("--switch-mode <mode>", "Inspect with an explicit switch mode").choices([
        "auto",
        "cd",
        "launch",
        "sesh",
        "herdr",
      ]),
    )
    .option("--worktrees-dir <path>", "Inspect with an explicit worktree directory")
    .option("-j, --json", "Output result as JSON")
    .action(async (options: EffectiveOptions) => {
      const resolved = await effectiveWithoutBootstrap();
      const effective = applyCliInspectionOverrides(resolved.effective, options);
      const data = {
        files: effective.files,
        mode: resolved.context.mode,
        settings: inspectableEntries(effective),
        workspaceRoot: resolved.context.workspaceRoot,
        worktreesBase: effective.worktreesBase,
      };
      if (options.json) {
        writeJsonEnvelope(createJsonSuccessEnvelope("config effective", data));
        return;
      }
      console.log(`Workspace mode: ${data.mode}`);
      console.log(`Workspace root: ${data.workspaceRoot}`);
      console.log(`Workspace config: ${data.files.workspace ?? "none"}`);
      console.log(`User config: ${data.files.user ?? "none"}`);
      console.log("Effective settings:");
      for (const [field, entry] of Object.entries(data.settings)) {
        console.log(`  ${field}: ${JSON.stringify(entry.value)} (${entry.source})`);
      }
    });

export function createCommand(): Command {
  return new Command("config")
    .description("Inspect Arashi configuration")
    .addCommand(createEffectiveCommand());
}
