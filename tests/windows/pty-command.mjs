import { writeFileSync } from "node:fs";
import * as pty from "node-pty";

const reusePrompt = "__ARASHI_CONPTY_REUSE_PROMPT__";
const reuseAnswer = "arashi-terminal-reused";

function runLegacy() {
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
}

function runSession(encodedConfig) {
  const config = JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
  const spec = Buffer.from(
    JSON.stringify({ command: config.command[0], args: config.command.slice(1) }),
    "utf8",
  ).toString("base64");
  const powershell = `
$specJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARASHI_PTY_SESSION_SPEC))
$spec = $specJson | ConvertFrom-Json
$exitCode = 1
try {
  & $spec.command @($spec.args)
  $exitCode = $LASTEXITCODE
}
finally {
  Write-Host -NoNewline '${reusePrompt}'
  $reuse = Read-Host
  Write-Host "__ARASHI_CONPTY_REUSED__:$reuse"
}
exit $exitCode
`;
  const terminal = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", powershell], {
    cols: 100,
    cwd: config.cwd,
    env: {
      ...process.env,
      ARASHI_PTY_SESSION_SPEC: spec,
      TERM: "xterm-256color",
    },
    name: "xterm-256color",
    rows: 30,
  });

  const started = Date.now();
  let output = "";
  let promptObserved = false;
  let reused = false;
  const timer = setTimeout(
    () => {
      terminal.kill();
      console.error(`ConPTY session did not finish. Output:\n${output}`);
      process.exit(124);
    },
    Number(config.timeoutMs ?? 30_000),
  );

  terminal.onData((data) => {
    output += data;
    process.stdout.write(data);
    if (!promptObserved && output.includes(config.prompt)) {
      promptObserved = true;
      if (config.response === "__CTRL_C__") {
        terminal.write("\x03");
      } else if (config.response !== "__NO_INPUT__") {
        terminal.write(`${config.response}\r`);
      }
    }
    if (!reused && output.includes(reusePrompt)) {
      reused = true;
      terminal.write(`${reuseAnswer}\r`);
    }
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    writeFileSync(
      config.resultPath,
      JSON.stringify({ durationMs: Date.now() - started, exitCode, output, reused }),
    );
    if (!promptObserved) {
      console.error(`ConPTY prompt was not observed: ${config.prompt}`);
      process.exit(125);
    }
    if (!reused) {
      console.error("ConPTY terminal reuse prompt was not observed");
      process.exit(126);
    }
    process.exit(0);
  });
}

if (process.argv[2] === "--session") {
  if (!process.argv[3]) {
    console.error("usage: node pty-command.mjs --session <base64-config-json>");
    process.exit(2);
  }
  runSession(process.argv[3]);
} else {
  runLegacy();
}
