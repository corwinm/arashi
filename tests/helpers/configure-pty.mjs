import { readFileSync, writeFileSync } from "node:fs";
import { spawnPty } from "./node-pty.mjs";

const root = process.argv[2];
const encoded = process.argv[3];
if (!root || !encoded) process.exit(2);
const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const source = `
import { executeConfigure } from ${JSON.stringify(`${root}/src/commands/configure.ts`)};
await executeConfigure({ stdinIsTTY: true, stdoutIsTTY: true });
`;
const terminal = spawnPty(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", source],
  { cols: 140, cwd: config.workspace, env: { ...process.env, TERM: "xterm-256color" }, rows: 45 },
);
let transcript = "";
let interaction = 0;
let searchOffset = 0;
let sending = false;
const timer = setTimeout(() => {
  terminal.kill();
  console.error(`PTY configure timed out at interaction ${interaction}.\n${transcript}`);
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
    if (step.replaceConfig !== undefined) writeFileSync(config.configPath, step.replaceConfig);
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
    console.error(`PTY configure exited before interaction ${interaction}.\n${transcript}`);
    process.exit(125);
  }
  try {
    readFileSync(config.configPath, "utf8");
  } catch {
    process.exit(126);
  }
  process.stdout.write(Buffer.from(transcript).toString("base64"));
  process.exit(exitCode ?? 1);
});
