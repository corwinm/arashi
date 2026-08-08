import { spawnPty } from "./node-pty.mjs";

const [, , cwd, prompt, response, timeoutSeconds, commandJson] = process.argv;
if (!cwd || !prompt || response === undefined || !timeoutSeconds || !commandJson) {
  console.error(
    "usage: node pty-command.mjs <cwd> <prompt> <response|__CTRL_C__|__NO_INPUT__> <timeout-seconds> <command-json>",
  );
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
let output = "";
let responded = false;
const timer = setTimeout(
  () => {
    terminal.kill();
    console.error(`PTY command did not finish. Output:\n${output}`);
    process.exit(124);
  },
  Number(timeoutSeconds) * 1000,
);

timer.unref();
terminal.onData((data) => {
  output += data;
  process.stdout.write(data);
  if (!responded && output.includes(prompt)) {
    responded = true;
    if (response === "__CTRL_C__") terminal.write("\u0003");
    else if (response !== "__NO_INPUT__") terminal.write(`${response}\r`);
  }
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (!responded) {
    console.error(`PTY prompt was not observed: ${prompt}`);
    process.exit(125);
  }
  process.exit(exitCode);
});
