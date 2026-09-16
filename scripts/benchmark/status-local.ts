// Keep the same collector boundary as base 166a377's benchmark adapter. Public
// --local CLI counts include workspace discovery and are absolute measurements,
// not a before/after comparison against this adapter.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkAllReposWithDependencies, collectStatusWarnings } from "../../src/commands/status.ts";
import type { Config } from "../../src/lib/config.ts";
const workspaceRoot = resolve(process.argv[2] ?? "");
const config = JSON.parse(
  await readFile(resolve(workspaceRoot, ".arashi", "config.json"), "utf8"),
) as Config;
const statuses = await checkAllReposWithDependencies(workspaceRoot, config, {
  local: true,
  dependencies: { fetchRemoteTrackingTarget: async () => ({ ok: true }) },
});
const errors = statuses.flatMap(({ error, name }) => (error ? [`${name}: ${error}`] : []));
if (errors.length) throw new Error(errors.join("\n"));
process.stdout.write(
  `${JSON.stringify({ data: { freshness: { mode: "local", remoteRefsRefreshed: false }, repositories: statuses }, warnings: collectStatusWarnings(statuses) })}\n`,
);
