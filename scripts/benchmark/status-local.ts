import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkAllReposWithDependencies } from "../../src/commands/status.ts";
import type { Config } from "../../src/lib/config.ts";

const workspaceRoot = resolve(process.argv[2] ?? "");
const config = JSON.parse(
  await readFile(resolve(workspaceRoot, ".arashi", "config.json"), "utf8"),
) as Config;
const statuses = await checkAllReposWithDependencies(workspaceRoot, config, {
  dependencies: {
    fetchRemoteTrackingTarget: () => Promise.resolve({ ok: true }),
  },
});
const errors = statuses.flatMap(({ error, name }) => (error ? [`${name}: ${error}`] : []));
if (errors.length > 0) {
  throw new Error(errors.join("\n"));
}

process.stdout.write(
  `${JSON.stringify({
    refreshWarnings: statuses.flatMap(({ name, refreshWarning }) =>
      refreshWarning ? [{ name, refreshWarning }] : [],
    ),
    repositories: statuses.map(({ name }) => name),
  })}\n`,
);
