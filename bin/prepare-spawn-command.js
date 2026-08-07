const WINDOWS_BATCH_FILE = /\.(?:cmd|bat)$/i;
const CMD_ARGUMENT_VARIABLE_PREFIX = "ARASHI_CMD_ARGUMENT_";
const CMD_LITERAL_PERCENT_VARIABLE = "ARASHI_CMD_LITERAL_PERCENT";

// Quote according to CommandLineToArgvW's rules. The result is stored in an
// environment variable and introduced with ordinary expansion. Cmd expands each
// fixed %VARIABLE% token once, but does not rescan user-controlled contents as
// command syntax. Delayed expansion stays disabled so literal ! characters survive.
const quoteWindowsArgument = (argument) =>
  `"${argument.replaceAll(/(\\*)"/g, String.raw`$1$1\"`).replace(/(\\*)$/, "$1$1")}"`;

export function prepareSpawnCommand(
  command,
  platform = process.platform,
  env = process.env,
  forceWindowsShell = false,
  callBatchFile = false,
) {
  const executable = command[0];
  if (
    platform !== "win32" ||
    (!forceWindowsShell && !WINDOWS_BATCH_FILE.test(executable))
  ) {
    return { args: command.slice(1), command: executable, windowsVerbatimArguments: false };
  }

  const values = command.map((argument) => {
    const quoted = quoteWindowsArgument(argument);
    return callBatchFile
      ? quoted.replaceAll("%", `%${CMD_LITERAL_PERCENT_VARIABLE}%`)
      : quoted;
  });
  const variableNames = values.map((_value, index) => `${CMD_ARGUMENT_VARIABLE_PREFIX}${index}`);

  const commandInterpreter =
    Object.entries(env).find(([key]) => key.toLowerCase() === "comspec")?.[1] ?? "cmd.exe";

  const invocation = variableNames.map((name) => `%${name}%`).join(" ");
  const args = ["/d"];
  if (callBatchFile) args.push("/e:on");
  args.push("/v:off", "/s", "/c", `"${callBatchFile ? "call " : ""}${invocation}"`);

  return {
    args,
    command: commandInterpreter,
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter(
          ([name]) =>
            !name.toUpperCase().startsWith(CMD_ARGUMENT_VARIABLE_PREFIX) &&
            name.toUpperCase() !== CMD_LITERAL_PERCENT_VARIABLE,
        ),
      ),
      ...(callBatchFile ? { [CMD_LITERAL_PERCENT_VARIABLE]: "%" } : {}),
      ...Object.fromEntries(variableNames.map((name, index) => [name, values[index]])),
    },
    windowsVerbatimArguments: true,
  };
}
