#!/usr/bin/env bun
import { closeSync } from "fs";
import { buildProgram } from "./cli-program.ts";

// FZF compatibility: close stdin only for list when piping output.
const argv = process.argv.slice(2);
let command = "";
for (const arg of argv) {
  if (arg.startsWith("-")) {
    continue;
  }
  command = arg;
  break;
}
if (!process.stdout.isTTY && command === "list") {
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
