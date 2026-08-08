import { spawnPty } from "./node-pty.mjs";

const [, , cwd, commandJson] = process.argv;
if (!cwd || !commandJson) {
  console.error("usage: node pty-input.mjs <cwd> <command-json>");
  process.exit(2);
}
const command = JSON.parse(commandJson);
if (!Array.isArray(command) || command.length === 0) {
  throw new TypeError("command-json must be a non-empty string array");
}

const terminal = spawnPty(command[0], command.slice(1), {
  cols: 100,
  cwd,
  env: { ...process.env, TERM: "xterm-256color" },
  name: "xterm-256color",
  rows: 30,
});
const timer = setTimeout(() => {
  terminal.kill();
  console.error("PTY command did not finish");
  process.exit(124);
}, 30_000);
timer.unref();
process.stdin.on("data", (chunk) => terminal.write(chunk.toString()));
terminal.onData((data) => process.stdout.write(data));
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  process.exit(exitCode);
});
