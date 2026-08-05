export const UPDATE_INSPECTION_CONFLICT_CODE = "UPDATE_INSPECTION_CONFLICT";
export const UPDATE_INSPECTION_CONFLICT_MESSAGE =
  "--check cannot be combined with --dry-run; choose one inspection mode.";

export class UpdateInspectionConflictError extends Error {
  constructor() {
    super(UPDATE_INSPECTION_CONFLICT_MESSAGE);
    this.name = "UpdateInspectionConflictError";
    this.code = UPDATE_INSPECTION_CONFLICT_CODE;
    this.details = { options: ["--check", "--dry-run"] };
  }
}

export function parseUpdateArgs(argv = []) {
  return {
    check: argv.includes("--check"),
    dryRun: argv.includes("--dry-run") || argv.includes("-n"),
    json: argv.includes("--json") || argv.includes("-j"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

export function assertValidUpdateInspectionOptions(options) {
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
