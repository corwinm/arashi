import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

import { win32 } from "node:path";

export function releaseNpmCommand(
  platform = process.platform,
  nodeExecutable = process.execPath,
): string {
  return platform === "win32" ? win32.join(win32.dirname(nodeExecutable), "npm.cmd") : "npm";
}

export function releaseCommandInvocation(
  command: string,
  args: string[],
  platform = process.platform,
  commandInterpreter = process.env.ComSpec || "cmd.exe",
): { args: string[]; command: string; windowsVerbatimArguments?: boolean } {
  if (platform === "win32") {
    const commandLine = ["call", command, ...args]
      .map((value, index) => {
        if (index === 0) return value;
        if (index === 1 && !/[\s"&|<>^()]/u.test(value)) return value;
        return `"${value.replaceAll('"', '""')}"`;
      })
      .join(" ");
    return {
      args: ["/d", "/s", "/c", commandLine],
      command: commandInterpreter,
      windowsVerbatimArguments: true,
    };
  }
  return { args, command };
}

export function spawnReleaseCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  const invocation = releaseCommandInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}
