import semanticCases from "./prompt-cases.json" with { type: "json" };
import { createRequire } from "node:module";
import { ensureDarwinSpawnHelperExecutable } from "../helpers/node-pty-permissions.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(
  process.env.ARASHI_PROMPT_NODE_MODULES
    ? resolve(process.env.ARASHI_PROMPT_NODE_MODULES, "../package.json")
    : import.meta.url,
);
ensureDarwinSpawnHelperExecutable(require);
const pty = require("node-pty");
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const source = args.includes("--source") ? resolve(option("--source")) : null;
const binary = source ? process.execPath : resolve(option("--binary"));
const rows = [
  ["arrows", "Choose item", "\x1b[B\x1b[A\x1b[B\r"],
  ["wrap", "Choose item", "k\r"],
  ["cancel-select", "Choose item", "\x03"],
  ["cancel-multi", "Choose items", "\x03"],
  ["cancel-confirm", "Proceed", "\x03"],
  ["panic-restore", "Enter text", "\r"],
  ["existing-raw", "Enter text", "ok\r"],
  ["select", "Choose item", "j\r"],
  ["default-select", "Choose item", "\r"],
  ["multi", "Choose items", "j k \r"],
  ["empty-multi", "Choose items", "\r"],
  ["input", "Enter text", "jké\r"],
  ["default-input", "Enter text", "\r"],
  ["validate", "Enter text", "bad\r", "Try again", "\u007f\u007f\u007fok\r"],
  ["confirm", "Proceed", "\r"],
  ["yes", "Proceed", "\r"],
  ["cancel", "Enter text", "\u0003"],
  ["eof", "Enter text", "\u0004"],
  ["empty-select", "PROMPT_RESULT_OK", ""],
];
rows.push(
  ...semanticCases.map((c) => [c.id, c.kind === "input" ? "Enter text" : "Proceed", c.keys]),
);
const progressPath = args.includes("--progress") ? resolve(option("--progress")) : null;
let completed = 0;
const writeProgress = () => {
  if (progressPath) writeFileSync(progressPath, `${completed}/${rows.length}`);
};
const escapeCharacter = String.fromCodePoint(27);
const writeKeys = (child, keys) => {
  if (
    process.platform !== "win32" ||
    !new RegExp(`[${escapeCharacter}\\u{10000}-\\u{10ffff}]`, "u").test(keys)
  ) {
    child.write(keys);
    return;
  }
  const tokens =
    keys.match(new RegExp(`${escapeCharacter}(?:\\[[0-9;]*[A-Za-z~]|.)|[\\s\\S]`, "gu")) ?? [];
  const writeNext = (index) => {
    if (index === tokens.length) return;
    child.write(tokens[index]);
    setTimeout(() => writeNext(index + 1), 10);
  };
  writeNext(0);
};
writeProgress();
const results = [];
let failures = 0;
for (const [id, token, keys, retryToken, retryKeys] of rows) {
  if (
    source &&
    [
      "validate",
      "eof",
      "empty-select",
      "empty-multi",
      "arrows",
      "wrap",
      "cancel-select",
      "cancel-multi",
      "cancel-confirm",
      "panic-restore",
      "existing-raw",
    ].includes(id)
  )
    continue;
  if (args.includes("--semantic-only") && !semanticCases.some((c) => c.id === id)) continue;
  const home = mkdtempSync(join(tmpdir(), "arashi-prompt-"));
  try {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      ARASHI_PROMPT_CASE: id,
      TERM: "xterm-256color",
    };
    const semantic = semanticCases.find((c) => c.id === id);
    if (semantic) env.ARASHI_PROMPT_SEMANTIC = JSON.stringify(semantic);
    delete env.ARASHI_DIRECTIVE_FILE;
    delete env.ARASHI_SHELL;
    const argv = source
      ? [resolve(import.meta.dirname, "prompt-source.mjs"), source]
      : ["--exact", "prompt_fixture", "--nocapture"];
    // The system ConPTY path preserves astral input that node-pty 1.1.0's
    // bundled OpenConsole drops. Clean up its handles directly after onExit.
    const child = pty.spawn(binary, argv, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: home,
      env,
      useConpty: true,
      useConptyDll: false,
    });
    let output = "",
      stage = 0,
      timedOut = false;
    const result = await new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 15000);
      const settlement = setTimeout(
        () => reject(new Error(`${id}: PTY child failed to settle after kill\n${output}`)),
        20000,
      );
      child.onData((data) => {
        output += data;
        if (stage === 0 && output.includes(token)) {
          stage = 1;
          writeKeys(child, keys);
        }
        if (stage === 1 && retryToken && output.includes(retryToken)) {
          stage = 2;
          writeKeys(child, retryKeys);
        }
        if (stage < 3 && output.includes("Reuse terminal")) {
          stage = 3;
          writeKeys(child, "reuse\r");
        }
      });
      child.onExit((event) => {
        clearTimeout(timer);
        clearTimeout(settlement);
        accept({ id, ...event, timedOut, output });
      });
    });
    // Release the owned ConPTY handles only after recording the real exit.
    // Avoid child.kill() here: the legacy path probes already-exited child PIDs.
    if (process.platform === "win32" && !timedOut) {
      child._agent._inSocket.destroy();
      child._agent._outSocket.destroy();
      child._agent._conoutSocketWorker.dispose();
    }
    results.push(result);
    if (args.includes("--report"))
      writeFileSync(resolve(option("--report")), JSON.stringify(results, null, 2));
    assert.equal(timedOut, false, `${id}: deadline\n${output}`);
    assert.equal(result.exitCode, 0, `${id}\n${output}`);
    assert.match(output, /PROMPT_RESULT_OK/);
    assert.match(output, /REUSE_OK/);
    if (id === "select") assert.match(output, /description/);
    console.log(`PASS ${source ? "source" : "native"} ${id}`);
  } catch (error) {
    failures++;
    console.error(error.message);
  } finally {
    completed++;
    writeProgress();
    rmSync(home, { recursive: true, force: true });
  }
}
if (args.includes("--report"))
  writeFileSync(resolve(option("--report")), JSON.stringify(results, null, 2));
if (failures) process.exitCode = 1;
console.log(
  `${results.length - failures}/${results.length} PTY cases passed (${process.platform === "win32" ? "ConPTY" : "POSIX PTY"})`,
);
