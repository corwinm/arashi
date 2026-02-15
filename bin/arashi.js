#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const argv = process.argv.slice(2);
const isWindows = process.platform === "win32";
const wrapper = isWindows ? "arashi.bat" : "arashi";
const wrapperPath = join(__dirname, wrapper);

const child = isWindows
  ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", wrapperPath, ...argv], {
      stdio: "inherit",
      windowsHide: false,
    })
  : spawn(wrapperPath, argv, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }

  process.exit(signal ? 1 : 0);
});

child.on("error", (error) => {
  console.error(`Failed to start arashi. ${error.message}.`);
  process.exit(1);
});
