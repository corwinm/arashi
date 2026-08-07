import * as pty from "node-pty";

const [, , command, cwd, answer, prompt, ...args] = process.argv;
if (!command || !cwd || answer === undefined || !prompt) {
  console.error("usage: node pty-command.mjs <command> <cwd> <answer> <prompt> [args...]");
  process.exit(2);
}

const terminal = pty.spawn(command, args, {
  cols: 100,
  cwd,
  env: { ...process.env, TERM: "xterm-256color" },
  name: "xterm-256color",
  rows: 30,
});

let output = "";
let answered = false;
const timer = setTimeout(() => {
  console.error(`PTY command did not finish. Output:\n${output}`);
  terminal.kill();
  process.exit(124);
}, 30_000);

timer.unref();
terminal.onData((data) => {
  output += data;
  process.stdout.write(data);
  if (!answered && output.includes(prompt)) {
    answered = true;
    terminal.write(`${answer}\r`);
  }
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (!answered) {
    console.error(`PTY prompt was not observed: ${prompt}`);
    process.exit(125);
  }
  process.exit(exitCode);
});
