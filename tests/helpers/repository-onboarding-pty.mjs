import { readFileSync } from "node:fs";
import { spawnPty } from "./node-pty.mjs";

const root = process.argv[2];
const encoded = process.argv[3];
if (!root || !encoded) process.exit(2);
const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const source = `
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { collectRepositoryOnboarding } from ${JSON.stringify(`${root}/src/lib/repository-onboarding.ts`)};
import { createRepositoryEditorState } from ${JSON.stringify(`${root}/src/lib/repository-config-editor.ts`)};
import { discoverRepositoryLocalCandidates } from ${JSON.stringify(`${root}/src/lib/repository-candidate-discovery.ts`)};
import { installRepositoryScripts } from ${JSON.stringify(`${root}/src/lib/repository-script-transaction.ts`)};
import { discoverLifecycleHookCandidates } from ${JSON.stringify(`${root}/src/lib/hooks.ts`)};
const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const editor = createRepositoryEditorState({ version: "1.0.0", reposDir: "repos", repos: { app: { gitUrl: "x", path: "repos/app" } } }, "app");
const existingHookPath = config.existingHookContent === undefined ? null : join(config.workspace, ".arashi", "hooks", "pre-create.app.sh");
if (existingHookPath) {
  await mkdir(dirname(existingHookPath), { recursive: true });
  await writeFile(existingHookPath, config.existingHookContent);
}
const result = await collectRepositoryOnboarding({
  discover: () => discoverRepositoryLocalCandidates(config.repository),
  editor,
  observeActivePaths: async (request) => Promise.all(request.lifecycles.map(async ({ lifecycle }) => ({
    lifecycle,
    nativeCandidateCount: (await discoverLifecycleHookCandidates(\`${"${lifecycle}"}.app\`, config.workspace, process.platform)).length,
  }))),
  scriptContext: { activeConfigRoot: config.workspace, activeRepositoryPath: config.repository, platform: process.platform },
});
const installed = [];
if (result.status === "confirmed") {
  await installRepositoryScripts(result.editor.scripts);
  for (const plan of result.editor.scripts) {
    const observed = await stat(plan.path);
    installed.push({ content: await readFile(plan.path, "utf8"), mode: observed.mode & 0o777, path: plan.path });
  }
}
const existingHookContent = existingHookPath ? await readFile(existingHookPath, "utf8") : undefined;
await writeFile(config.resultPath, JSON.stringify({ existingHookContent, installed, result }));
`;
const terminal = spawnPty(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", source, encoded],
  {
    cols: 120,
    cwd: root,
    env: { ...process.env, TERM: "xterm-256color" },
    name: "xterm-256color",
    rows: 40,
  },
);
let transcript = "";
let interaction = 0;
let searchOffset = 0;
let sending = false;
const timer = setTimeout(() => {
  terminal.kill();
  console.error(
    `PTY onboarding did not finish at interaction ${interaction} (${config.interactions[interaction]?.waitFor ?? "exit"}).\n${transcript}`,
  );
  process.exit(124);
}, 15_000);
const advance = () => {
  if (sending || interaction >= config.interactions.length) return;
  const step = config.interactions[interaction];
  const found = transcript.indexOf(step.waitFor, searchOffset);
  if (found < 0) return;
  sending = true;
  searchOffset = found + step.waitFor.length;
  interaction += 1;
  setTimeout(() => {
    terminal.write(step.bytes);
    sending = false;
    advance();
  }, 15);
};
terminal.onData((bytes) => {
  transcript += bytes;
  advance();
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (interaction !== config.interactions.length) {
    console.error(`PTY exited before interaction ${interaction}:\n${transcript}`);
    process.exit(125);
  }
  try {
    readFileSync(config.resultPath, "utf8");
  } catch {
    console.error(`PTY did not produce a result (exit ${exitCode}):\n${transcript}`);
    process.exit(126);
  }
  process.stdout.write(Buffer.from(transcript).toString("base64"));
  process.exit(exitCode ?? 1);
});
