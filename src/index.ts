#!/usr/bin/env bun
import { closeSync } from "fs";
import { buildProgram } from "./cli-program.ts";

// FZF compatibility: close stdin for list or forced remove when piping output.
const argv = process.argv.slice(2);
let command = "";
let forceRemove = false;
for (const arg of argv) {
  if (arg.startsWith("-")) {
    if (arg === "-f" || arg === "--force") forceRemove = true;
    continue;
  }
  command = arg;
  break;
}
if (!process.stdout.isTTY && (command === "list" || (command === "remove" && forceRemove))) {
  try {
    closeSync(0);
  } catch {
    try {
      process.stdin.pause();
      process.stdin.destroy();
    } catch {
      // stdin closing is best-effort
    }
  }
}

buildProgram().parse();
