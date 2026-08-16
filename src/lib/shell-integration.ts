import { runtime } from "./runtime.ts";
import { basename, dirname, join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

const START_MARKER = "# >>> arashi shell integration >>>";
const END_MARKER = "# <<< arashi shell integration <<<";

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;

export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export interface ShellInstallResult {
  created: boolean;
  shell: SupportedShell;
  startupFilePath: string;
  updated: boolean;
}

export function isSupportedShell(value: string): value is SupportedShell {
  return SUPPORTED_SHELLS.includes(value as SupportedShell);
}

export function detectSupportedShell(
  env: Record<string, string | undefined> = process.env,
): SupportedShell | null {
  const shellPath = env.SHELL?.trim();
  if (!shellPath) {
    return null;
  }

  const shellName = basename(shellPath).toLowerCase();
  return isSupportedShell(shellName) ? shellName : null;
}

function renderFishShellFunction(name: "arashi" | "aw"): string {
  return `function ${name} --wraps ${name} --description "Run arashi with shell integration"
    # arashi-managed-shell-wrapper:${name}:v1
    set -l tmp_root /tmp
    if test -n "$TMPDIR"
        set tmp_root $TMPDIR
    end

    set -l directive_file (mktemp "$tmp_root/arashi-directive.XXXXXX")
    if test -z "$directive_file"
        return 1
    end

    set -lx ARASHI_DIRECTIVE_FILE "$directive_file"
    set -lx ARASHI_SHELL fish
    command ${name} $argv
    set -l status_code $status

    if test -s "$directive_file"
        source "$directive_file"
    end

    rm -f "$directive_file"
    return $status_code
end
`;
}

export function buildShellInitScript(shell: SupportedShell): string {
  if (shell === "fish") {
    return `${renderFishShellFunction("arashi")}
if not functions -q aw; or functions aw | string match -q '*arashi-managed-shell-wrapper:aw:v1*'
${renderFishShellFunction("aw")}end
`;
  }

  const renderPosixFunction = (name: "arashi" | "aw") => `${name}() {
  : arashi-managed-shell-wrapper:${name}:v1
  local directive_file status_code
  directive_file="$(mktemp "\${TMPDIR:-/tmp}/arashi-directive.XXXXXX")" || return 1

  ARASHI_DIRECTIVE_FILE="$directive_file" ARASHI_SHELL=${shell} command ${name} "$@"
  status_code=$?

  if [ -s "$directive_file" ]; then
    . "$directive_file"
  fi

  rm -f "$directive_file"
  return "$status_code"
}
`;
  const aliasGuard =
    shell === "zsh"
      ? `if (( ! \${+aliases[aw]} )); then
  if (( ! \${+functions[aw]} )) || [[ "\${functions[aw]}" == *arashi-managed-shell-wrapper:aw:v1* ]]; then
${renderPosixFunction("aw")}  fi
fi`
      : `if ! alias aw >/dev/null 2>&1 && { ! declare -F aw >/dev/null 2>&1 || declare -f aw | grep -Fq arashi-managed-shell-wrapper:aw:v1; }; then
${renderPosixFunction("aw")}fi`;
  return `${renderPosixFunction("arashi")}
${aliasGuard}
`;
}

export async function installShellIntegration(
  options: {
    env?: Record<string, string | undefined>;
    shell?: SupportedShell;
  } = {},
): Promise<ShellInstallResult> {
  const env = options.env ?? process.env;
  const shell = options.shell ?? detectSupportedShell(env);

  if (!shell) {
    throw new Error(
      "Unable to detect a supported shell for `arashi shell install`. Use `arashi shell init <bash|zsh|fish>` for manual setup. Then run `arashi completion <bash|zsh|fish>` to activate completion.",
    );
  }

  const startupFilePath = await resolveStartupFilePath(shell, env);
  if (!startupFilePath) {
    throw new Error(
      `Unable to determine a writable startup file for ${shell}. Use \`arashi shell init ${shell}\` and \`arashi completion ${shell}\` for manual setup.`,
    );
  }

  const startupFile = runtime.file(startupFilePath);
  const existed = await startupFile.exists();
  const currentContents = existed ? await startupFile.text() : "";
  const block = buildShellInstallBlock(shell);
  const nextContents = upsertManagedBlock(currentContents, block);

  if (currentContents !== nextContents) {
    try {
      await mkdir(dirname(startupFilePath), { recursive: true });
      await runtime.write(startupFilePath, nextContents);
    } catch {
      throw new Error(
        `Unable to write ${startupFilePath}. Use \`arashi shell init ${shell}\` and \`arashi completion ${shell}\` for manual setup.`,
      );
    }
  }

  return {
    created: !existed,
    shell,
    startupFilePath,
    updated: currentContents !== nextContents,
  };
}

export async function resolveStartupFilePath(
  shell: SupportedShell,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const home = env.HOME?.trim() || homedir();
  if (!home) {
    return null;
  }

  const candidates = getStartupFileCandidates(home, shell);

  for (const candidate of candidates) {
    if (await runtime.file(candidate).exists()) {
      return candidate;
    }
  }

  return candidates[0] ?? null;
}

function getStartupFileCandidates(home: string, shell: SupportedShell): string[] {
  if (shell === "bash") {
    if (process.platform === "darwin") {
      return [join(home, ".bash_profile"), join(home, ".bashrc"), join(home, ".profile")];
    }

    return [join(home, ".bashrc"), join(home, ".bash_profile"), join(home, ".profile")];
  }

  if (shell === "zsh") {
    return [join(home, ".zshrc")];
  }

  return [join(home, ".config", "fish", "config.fish")];
}

export function buildShellInstallBlock(shell: SupportedShell): string {
  const body =
    shell === "fish"
      ? "command arashi shell init fish | source\ncommand arashi completion fish | source"
      : `eval "$(command arashi shell init ${shell})"\nsource <(command arashi completion ${shell})`;

  return `${START_MARKER}\n${body}\n${END_MARKER}`;
}

function upsertManagedBlock(currentContents: string, block: string): string {
  const trimmedBlock = `${block.trim()}\n`;
  const startIndex = currentContents.indexOf(START_MARKER);
  const endIndex = currentContents.indexOf(END_MARKER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const blockEnd = endIndex + END_MARKER.length;
    return `${currentContents.slice(0, startIndex)}${block.trim()}${currentContents.slice(blockEnd)}`;
  }

  const trimmedCurrent = currentContents.trimEnd();
  if (trimmedCurrent.length === 0) {
    return trimmedBlock;
  }

  return `${trimmedCurrent}\n\n${trimmedBlock}`;
}
