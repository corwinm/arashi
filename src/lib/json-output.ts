import { EmptyRepositoryFiltersError } from "./repo-filter.ts";

export const JSON_SCHEMA_VERSION = 1;

export interface JsonWarning {
  code?: string;
  details?: Record<string, unknown>;
  message: string;
}

export interface JsonCommandError {
  code: string;
  details?: Record<string, unknown>;
  message: string;
}

export interface JsonSuccessEnvelope<TData = Record<string, unknown>> {
  ok: true;
  command: string;
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  data: TData;
  warnings: JsonWarning[];
}

export interface JsonErrorEnvelope {
  ok: false;
  command: string;
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  error: JsonCommandError;
  warnings: JsonWarning[];
}

export type JsonEnvelope<TData = Record<string, unknown>> =
  | JsonSuccessEnvelope<TData>
  | JsonErrorEnvelope;

export const createJsonSuccessEnvelope = <TData>(
  command: string,
  data: TData,
  warnings: JsonWarning[] = [],
): JsonSuccessEnvelope<TData> => ({
  command,
  data,
  ok: true,
  schemaVersion: JSON_SCHEMA_VERSION,
  warnings,
});

export const createJsonErrorEnvelope = (
  command: string,
  error: JsonCommandError,
  warnings: JsonWarning[] = [],
): JsonErrorEnvelope => ({
  command,
  error,
  ok: false,
  schemaVersion: JSON_SCHEMA_VERSION,
  warnings,
});

export const stringifyJsonEnvelope = (envelope: JsonEnvelope): string =>
  JSON.stringify(envelope, null, 2);

export const writeJsonEnvelope = (envelope: JsonEnvelope): void => {
  process.stdout.write(`${stringifyJsonEnvelope(envelope)}\n`);
};

export const unknownErrorToJsonError = (
  error: unknown,
  code = "UNKNOWN_ERROR",
): JsonCommandError => {
  if (error instanceof EmptyRepositoryFiltersError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
    };
  }

  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null
  ) {
    return {
      code: error.code,
      details: error.details as Record<string, unknown>,
      message: error.message,
    };
  }

  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
};

export const unsupportedJsonModeError = (command: string, mode: string): JsonErrorEnvelope =>
  createJsonErrorEnvelope(command, {
    code: "JSON_UNSUPPORTED_FOR_MODE",
    details: { mode },
    message: `JSON output is not supported for ${mode}.`,
  });
