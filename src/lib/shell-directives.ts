import { runtime } from "#runtime";
import type { SupportedShell } from "./shell-integration.ts";

export const ARASHI_DIRECTIVE_FILE_ENV = "ARASHI_DIRECTIVE_FILE";
export const ARASHI_SHELL_ENV = "ARASHI_SHELL";

export interface DirectiveContext {
  filePath: string;
  shell: SupportedShell;
}

export function getDirectiveContext(
  env: Record<string, string | undefined> = process.env,
): DirectiveContext | null {
  const filePath = env[ARASHI_DIRECTIVE_FILE_ENV]?.trim();
  const shell = env[ARASHI_SHELL_ENV]?.trim();

  if (!filePath || (shell !== "bash" && shell !== "zsh" && shell !== "fish")) {
    return null;
  }

  return {
    filePath,
    shell,
  };
}

export function stripDirectiveEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sanitized = { ...env };
  delete sanitized[ARASHI_DIRECTIVE_FILE_ENV];
  delete sanitized[ARASHI_SHELL_ENV];
  return sanitized;
}

export function normalizeSpawnEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(stripDirectiveEnvironment(env))) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }

  return normalized;
}

export function buildCdDirective(worktreePath: string, shell: SupportedShell): string {
  if (shell === "fish") {
    return `cd -- "${escapeDoubleQuotedPath(worktreePath)}"\n`;
  }

  return `cd -- '${worktreePath.replaceAll("'", `'\\''`)}'\n`;
}

export async function writeCdDirective(
  context: DirectiveContext,
  worktreePath: string,
): Promise<void> {
  await runtime.write(context.filePath, buildCdDirective(worktreePath, context.shell));
}

function escapeDoubleQuotedPath(value: string): string {
  return value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll("$", String.raw`\$`)
    .replaceAll("`", String.raw`\``);
}
