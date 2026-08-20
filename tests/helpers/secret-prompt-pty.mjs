import { spawnPty } from "./node-pty.mjs";

const root = process.argv[2];
const canary = process.argv[3];
if (!root || !canary) process.exit(2);
const source = `import { secretInput } from ${JSON.stringify(`${root}/src/lib/prompts.ts`)};
const result = await secretInput("Sensitive hook body:");
console.log(result.status === "ok" ? "__SECRET_PROMPT_DONE__" : "__SECRET_PROMPT_CANCELLED__");`;
const terminal = spawnPty(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "-e", source],
  {
    cols: 100,
    cwd: root,
    env: { ...process.env, TERM: "xterm-256color" },
    name: "xterm-256color",
    rows: 20,
  },
);
let transcript = "";
let sent = false;
const timer = setTimeout(() => {
  terminal.kill();
  process.exit(124);
}, 10_000);
terminal.onData((bytes) => {
  transcript += bytes;
  if (!sent && transcript.includes("Sensitive hook body:")) {
    sent = true;
    terminal.write(`${canary}\r`);
  }
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  process.stdout.write(Buffer.from(transcript).toString("base64"));
  process.exit(exitCode ?? 1);
});
