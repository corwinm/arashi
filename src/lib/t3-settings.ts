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

/** Merge explicit handoff flags over already-resolved personal defaults. */
export function mergeT3Settings(
  explicit: T3Settings,
  defaults: T3Settings | undefined,
): T3Settings {
  return {
    ...validateT3Settings(defaults, "defaults.t3"),
    ...validateT3Settings(explicit, "T3 options"),
  };
}
