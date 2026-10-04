import { dirname, join, resolve } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import { ArashiError } from "./errors.ts";
import { exec } from "./git.ts";
import {
  getUserConfigPath,
  loadUserConfig,
  resolveEffectivePersonalConfig,
} from "./user-config.ts";
import { workspaceJsonMetadata } from "./workspace-context.ts";
import { DEFAULT_WORKTREES_DIR } from "./worktree-location.ts";
import { readConfigForDiagnostics, type DiagnosticLoadedConfig } from "./config.ts";
import { mergeT3Settings, type T3Settings } from "./t3-settings.ts";

export type T3ReadinessSettingSource = "cli" | "workspace" | "user" | "environment" | "builtin";

export interface T3ReadinessContext {
  checkout: string | null;
  workspaceRoot: string | null;
  workspace: DiagnosticLoadedConfig | null;
  roots: { repositoriesBase: string; worktreesBase: string } | null;
  settings: T3Settings;
  sources: Partial<Record<keyof T3Settings, T3ReadinessSettingSource>>;
}

interface CheckoutIdentity {
  checkout: string;
  primary: string;
  primaryBare: boolean;
}

// Git line output has one terminator; whitespace within a physical path is data.
const gitLine = (value: string): string => value.replace(/\r?\n$/u, "");

async function physicalHome(): Promise<string> {
  const home = dirname(dirname(getUserConfigPath()));
  try {
    return await realpath(home);
  } catch {
    return resolve(home);
  }
}

async function discoverWorkspace(identity: CheckoutIdentity | null): Promise<{
  root: string;
  mainRoot: string;
  loaded: DiagnosticLoadedConfig;
} | null> {
  if (!identity) return null;
  const home = await physicalHome();
  const visited = new Set<string>();
  const identities = [identity];
  async function localAncestors(start: string, owner = identity!) {
    let root = start;
    while (true) {
      if (root !== home && !visited.has(root)) {
        visited.add(root);
        const loaded = await readConfigForDiagnostics(root);
        if (loaded) {
          const mainRoot =
            root === owner.checkout || root === owner.primary
              ? owner.primary
              : ((await checkoutIdentity(root))?.primary ?? root);
          return { loaded, mainRoot, root };
        }
      }
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
  }
  // Validate applicable local authority before choosing a bare common owner.
  const local = await localAncestors(identity.checkout);
  if (identity.primaryBare && identity.primary !== home) {
    const loaded = await readConfigForDiagnostics(identity.primary);
    visited.add(identity.primary);
    if (loaded) return { loaded, mainRoot: identity.primary, root: identity.primary };
  }
  if (local) return local;
  const primaryLocal = await localAncestors(identity.primary);
  if (primaryLocal) return primaryLocal;

  // A nested independent child can inherit its containing checkout's owner.
  let ancestor = dirname(identity.checkout);
  while (dirname(ancestor) !== ancestor) {
    let hasGit = false;
    try {
      await stat(join(ancestor, ".git"));
      hasGit = true;
    } catch {
      /* Absent metadata. */
    }
    if (hasGit) {
      const parentIdentity = await checkoutIdentity(ancestor);
      if (parentIdentity && !identities.some((entry) => entry.primary === parentIdentity.primary)) {
        identities.push(parentIdentity);
        const parentLocal = await localAncestors(parentIdentity.primary, parentIdentity);
        if (parentLocal) return parentLocal;
      }
    }
    ancestor = dirname(ancestor);
  }
  for (const entry of identities) {
    if (entry.primary === home) continue;
    // Unborn repositories are legitimate checkouts with no tracked config.
    try {
      await exec(["rev-parse", "--verify", "HEAD"], entry.primary);
    } catch {
      continue;
    }
    const loaded = await readConfigForDiagnostics(entry.primary, { bareRepoPath: entry.primary });
    if (loaded) return { loaded, mainRoot: entry.primary, root: entry.primary };
  }
  return null;
}

async function checkoutIdentity(path: string): Promise<CheckoutIdentity | null> {
  const bare = await exec(["rev-parse", "--is-bare-repository"], path).catch(
    async (error: unknown) => {
      if (!(error instanceof ArashiError) || error.code !== "NOT_A_REPOSITORY") {
        throw error;
      }
      // Broken repository metadata is an identity failure, not global readiness.
      let ancestor = path;
      while (true) {
        try {
          await lstat(join(ancestor, ".git"));
          throw error;
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw inspectionError;
          }
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          return null;
        }
        ancestor = parent;
      }
    },
  );
  if (!bare) {
    return null;
  }
  if (bare.stdout.trim() === "true") return null;
  const top = await exec(["rev-parse", "--show-toplevel"], path);
  const checkout = await realpath(gitLine(top.stdout));
  const common = await exec(["rev-parse", "--git-common-dir"], path);
  await stat(resolve(path, gitLine(common.stdout)));
  const listing = await exec(["worktree", "list", "--porcelain", "-z"], path);
  const records = listing.stdout
    .split("\0\0")
    .filter(Boolean)
    .map((record) => record.split("\0"));
  const paths = records.map((record) =>
    record.find((field) => field.startsWith("worktree "))?.slice(9),
  );
  // Git records physical checkout paths. Only the selected and primary roots
  // Need to exist; unrelated stale registrations must not require repair.
  if (!paths.some((entry) => entry !== undefined && resolve(entry) === checkout) || !paths[0])
    throw new Error("Unregistered checkout");
  return { checkout, primary: await realpath(paths[0]), primaryBare: records[0]!.includes("bare") };
}

/** Resolve diagnostic context without contacting the native application. */
export async function resolveT3ReadinessContext(options: {
  cwd: string;
  path?: string;
  explicitSettings: T3Settings;
}): Promise<T3ReadinessContext> {
  let identity: CheckoutIdentity | null = null;
  try {
    const selected = await realpath(resolve(options.cwd, options.path ?? "."));
    const info = await stat(selected);
    if (!info.isDirectory() || !(info.mode & 0o444) || !(info.mode & 0o111)) {
      throw new Error("Unreadable checkout");
    }
    identity = await checkoutIdentity(selected);
    if (options.path !== undefined && (!identity || identity.checkout !== selected)) {
      throw new Error("Expected exact checkout");
    }
  } catch (error) {
    if (options.path !== undefined) {
      throw new Error("Path must select a readable registered Git checkout", { cause: error });
    }
    throw error;
  }
  const workspace = await discoverWorkspace(identity);
  const effective = workspace
    ? await resolveEffectivePersonalConfig({
        builtInWorktreesDir:
          identity?.primaryBare && workspace.root === identity.primary
            ? ".."
            : DEFAULT_WORKTREES_DIR,
        mainRoot: workspace.mainRoot,
        workspaceRoot: workspace.root,
        workspaceConfig: workspace.loaded.config,
        workspaceConfigPath: workspace.loaded.configPath,
        workspaceWorktreesDirAuthored: workspace.loaded.authoredWorktreesDir === true,
      })
    : null;
  const user = effective ? effective.userConfig : (await loadUserConfig())?.config;
  const environmentBase = process.env.T3CODE_HOME;
  const authoredBase =
    options.explicitSettings.baseDir ??
    workspace?.loaded.config.defaults?.t3?.baseDir ??
    user?.defaults?.t3?.baseDir;
  const settings = mergeT3Settings(
    options.explicitSettings,
    mergeT3Settings(
      workspace?.loaded.config.defaults?.t3 ?? {},
      mergeT3Settings(user?.defaults?.t3 ?? {}, {
        baseDir:
          authoredBase ?? (environmentBase || join(dirname(dirname(getUserConfigPath())), ".t3")),
        cli: "t3",
      }),
    ),
  );
  const sources: T3ReadinessContext["sources"] = {
    baseDir: environmentBase ? "environment" : "builtin",
    cli: "builtin",
  };
  for (const field of Object.keys(user?.defaults?.t3 ?? {}) as (keyof T3Settings)[]) {
    sources[field] = "user";
  }
  for (const field of Object.keys(
    workspace?.loaded.config.defaults?.t3 ?? {},
  ) as (keyof T3Settings)[]) {
    sources[field] = "workspace";
  }
  for (const field of Object.keys(options.explicitSettings) as (keyof T3Settings)[]) {
    sources[field] = "cli";
  }
  return {
    checkout: identity?.checkout ?? null,
    workspaceRoot: workspace?.root ?? null,
    workspace: workspace?.loaded ?? null,
    roots:
      workspace && effective
        ? (() => {
            const metadata = workspaceJsonMetadata({
              mode: "configured",
              invocationPath: options.cwd,
              workspaceRoot: workspace.root,
              config: effective.config,
              effective,
            });
            return {
              repositoriesBase: metadata.repositoriesBase,
              worktreesBase: metadata.worktreesBase,
            };
          })()
        : null,
    settings,
    sources,
  };
}
