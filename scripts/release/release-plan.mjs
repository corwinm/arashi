import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import semanticRelease from "semantic-release";

const planningPluginNames = new Set([
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
]);

export function releasePlanPlugins(config) {
  const plugins = config.plugins?.filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return planningPluginNames.has(name);
  });
  if (plugins?.length !== planningPluginNames.size) {
    throw new Error("Release configuration must contain the analyzer and notes plugins");
  }
  return plugins;
}

export async function runReleasePlan(repositoryUrl) {
  if (!repositoryUrl?.startsWith("file://")) {
    throw new Error("A local read-only release-plan repository is required");
  }
  const config = JSON.parse(
    await readFile(new URL("../../.releaserc.json", import.meta.url), "utf8"),
  );
  return semanticRelease({
    ...config,
    ci: false,
    dryRun: true,
    plugins: releasePlanPlugins(config),
    repositoryUrl,
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await runReleasePlan(process.argv[2]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
