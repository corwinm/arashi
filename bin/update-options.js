export const UPDATE_INSPECTION_CONFLICT_CODE = "UPDATE_INSPECTION_CONFLICT";
export const UPDATE_INSPECTION_CONFLICT_MESSAGE =
  "--check cannot be combined with --dry-run; choose one inspection mode.";
export const UPDATE_UNKNOWN_OPTION_CODE = "UPDATE_UNKNOWN_OPTION";

export class UpdateUnknownOptionError extends Error {
  constructor(options) {
    const suffix = options.length === 1 ? "" : "s";
    super(`Unknown option${suffix}: ${options.join(", ")}`);
    this.name = "UpdateUnknownOptionError";
    this.code = UPDATE_UNKNOWN_OPTION_CODE;
    this.details = { options };
  }
}

export class UpdateInspectionConflictError extends Error {
  constructor() {
    super(UPDATE_INSPECTION_CONFLICT_MESSAGE);
    this.name = "UpdateInspectionConflictError";
    this.code = UPDATE_INSPECTION_CONFLICT_CODE;
    this.details = { options: ["--check", "--dry-run"] };
  }
}

export function parseUpdateArgs(argv = []) {
  const delimiter = argv.indexOf("--");
  const optionArgv = delimiter === -1 ? argv : argv.slice(0, delimiter);
  const recognizedLongs = new Set(["--check", "--dry-run", "--json", "--yes"]);
  const recognizedShorts = new Set(["j", "n", "y"]);
  const groupedShorts = new Set();
  const unknownOptions = [];
  for (const token of optionArgv) {
    if (recognizedLongs.has(token)) continue;
    if (token.startsWith("--")) {
      unknownOptions.push(token);
      continue;
    }
    if (!/^-[^-]/.test(token)) continue;
    const characters = token.slice(1).split("");
    if (!characters.every((character) => recognizedShorts.has(character))) {
      unknownOptions.push(token);
      continue;
    }
    for (const character of characters) groupedShorts.add(character);
  }
  const has = (long, short) => optionArgv.includes(long) || optionArgv.includes(short) || groupedShorts.has(short.slice(1));
  return {
    check: optionArgv.includes("--check"),
    dryRun: has("--dry-run", "-n"),
    json: has("--json", "-j"),
    unknownOptions,
    yes: has("--yes", "-y"),
  };
}

export function assertValidUpdateInspectionOptions(options) {
  if (options.unknownOptions?.length > 0) {
    throw new UpdateUnknownOptionError(options.unknownOptions);
  }
  if (options.check && options.dryRun) {
    throw new UpdateInspectionConflictError();
  }
}

export function createWrapperJsonEnvelope(command, result) {
  if (result.ok) {
    return { command, data: result.data ?? {}, ok: true, schemaVersion: 1, warnings: [] };
  }
  return {
    command,
    error: result.error,
    ok: false,
    schemaVersion: 1,
    warnings: [],
  };
}

export function stringifyWrapperJsonEnvelope(command, result) {
  return JSON.stringify(createWrapperJsonEnvelope(command, result), null, 2);
}
