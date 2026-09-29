import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Personal handoff choices; credentials and transport addresses never belong here. */
export interface T3Settings {
  /** Official T3 data directory (absolute path).
   * @minLength 1
   * @pattern ^(?=(?:/|[A-Za-z]:[\\/]|\\\\))(?=[\s\S]*\S)[^\u0000-\u001F]+$(?![\s\S])
   */
  baseDir?: string;
  /** Installed official t3 executable (command name or absolute path).
   * @minLength 1
   * @pattern ^(?=(?:/|[A-Za-z]:[\\/]|\\\\|[^/\\]+$))(?=[\s\S]*\S)[^\u0000-\u001F]+$(?![\s\S])
   */
  cli?: string;
  /** Configured provider instance id, or an unambiguous driver name.
   * @minLength 1
   * @pattern ^(?=[\s\S]*\S)[^\u0000-\u001F]+$(?![\s\S])
   */
  provider?: string;
  /** Supported model slug or alias.
   * @minLength 1
   * @pattern ^(?=[\s\S]*\S)[^\u0000-\u001F]+$(?![\s\S])
   */
  model?: string;
  /** Supported reasoning effort.
   * @minLength 1
   * @pattern ^(?=[\s\S]*\S)[^\u0000-\u001F]+$(?![\s\S])
   */
  effort?: string;
}

export function validateT3Settings(value: unknown, source: string): T3Settings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: must be an object`);
  }
  const settings: T3Settings = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !["baseDir", "cli", "provider", "model", "effort"].includes(key) ||
      typeof entry !== "string" ||
      !entry.trim() ||
      Array.from(entry).some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new Error(`${source}.${key}: expected a supported nonempty string field`);
    }
    if (key === "baseDir" && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(entry)) {
      throw new Error(`${source}.baseDir: must be an absolute path`);
    }
    if (key === "cli" && /[\\/]/u.test(entry) && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(entry)) {
      throw new Error(`${source}.cli: use a command name or an absolute executable path`);
    }
    settings[key as keyof T3Settings] = entry;
  }
  return settings;
}

/** Isolated until #387 supplies the general user resolver: read only defaults.t3. */
export async function resolveT3Settings(
  explicit: T3Settings,
  workspace: T3Settings | undefined,
  userPath = join(homedir(), ".arashi", "config.json"),
): Promise<T3Settings> {
  let user: T3Settings = {};
  try {
    const config = JSON.parse(await readFile(userPath, "utf8"));
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      (config.defaults !== undefined &&
        (!config.defaults || typeof config.defaults !== "object" || Array.isArray(config.defaults)))
    )
      throw new Error(`${userPath}: defaults must be an object`);
    user = validateT3Settings(config?.defaults?.t3, `${userPath}: defaults.t3`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Unable to load T3 preferences from ${userPath}: ${error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : "invalid configuration"}`,
        { cause: error },
      );
    }
  }
  return {
    ...user,
    ...validateT3Settings(workspace, "defaults.t3"),
    ...validateT3Settings(explicit, "T3 options"),
  };
}
