import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnPty } from "./node-pty.mjs";

const encodedConfig = process.argv[2];
if (!encodedConfig) {
  console.error("usage: node pty-session.mjs <base64-config-json>");
  process.exit(2);
}

const config = JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
const reusePrompt = "__ARASHI_PTY_REUSE_PROMPT__";
const reuseAnswer = "arashi-terminal-reused";
const shell = `
trap '' INT
(
  trap - INT
  exec "$@" >"$ARASHI_PTY_STDOUT" 2>"$ARASHI_PTY_STDERR"
)
exit_code=$?
printf '%s' "$ARASHI_PTY_REUSE_PROMPT" >/dev/tty
IFS= read -r reused </dev/tty
printf '__ARASHI_PTY_REUSED__:%s\\n' "$reused" >/dev/tty
exit "$exit_code"
`;
const terminal = spawnPty("sh", ["-c", shell, "arashi-pty-session", ...config.command], {
  cols: 100,
  cwd: config.cwd,
  env: {
    ...process.env,
    ...config.env,
    ARASHI_PTY_REUSE_PROMPT: reusePrompt,
    ARASHI_PTY_STDERR: config.stderrPath,
    ARASHI_PTY_STDOUT: config.stdoutPath,
    TERM: "xterm-256color",
  },
  name: "xterm-256color",
  rows: 30,
});

const started = Date.now();
let output = "";
let promptObserved = false;
let reuseAnswered = false;
let reused = false;
const timer = setTimeout(
  () => {
    terminal.kill();
    console.error(`PTY session did not finish. Output:\n${output}`);
    process.exit(124);
  },
  Number(config.timeoutSeconds) * 1000,
);

timer.unref();
const promptPoll = setInterval(() => {
  if (promptObserved) return;
  let stderr = "";
  try {
    stderr = readFileSync(config.stderrPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const promptReady = stderr.includes(config.prompt);
  const fileReady = config.readyPath && existsSync(config.readyPath);
  if (!promptReady && !fileReady) return;
  promptObserved = true;
  if (config.response === "__CTRL_C__") terminal.write("\u0003");
  else if (config.response !== "__NO_INPUT__") terminal.write(`${config.response}\r`);
}, 20);
promptPoll.unref();
terminal.onData((data) => {
  output += data;
  process.stdout.write(data);
  if (!reuseAnswered && output.includes(reusePrompt)) {
    reuseAnswered = true;
    terminal.write(`${reuseAnswer}\r`);
  }
  if (output.includes(`__ARASHI_PTY_REUSED__:${reuseAnswer}`)) reused = true;
});
terminal.onExit(({ exitCode }) => {
  clearInterval(promptPoll);
  clearTimeout(timer);
  writeFileSync(
    config.resultPath,
    JSON.stringify({ durationMs: Date.now() - started, exitCode, reused }),
  );
  if (!promptObserved) {
    console.error(`PTY prompt was not observed: ${config.prompt}`);
    process.exit(125);
  }
  if (!reused) {
    console.error("PTY terminal reuse prompt was not observed");
    process.exit(126);
  }
  process.exit(0);
});
