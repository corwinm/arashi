export interface TerminalContext {
  isInteractive: boolean;
  columns: number | null;
}

interface TerminalOutput {
  columns?: number;
  isTTY?: boolean;
}

export function detectTerminalContext(output: TerminalOutput = process.stdout): TerminalContext {
  const isInteractive = Boolean(output.isTTY);
  const streamColumns = normalizeColumns(output.columns);
  const envColumns = normalizeColumns(parseEnvColumns(process.env.COLUMNS));

  return {
    isInteractive,
    columns: streamColumns ?? envColumns,
  };
}

export function hasMinimumColumns(context: TerminalContext, minimumColumns: number): boolean {
  if (context.columns === null) {
    return false;
  }

  return context.columns >= minimumColumns;
}

function parseEnvColumns(rawColumns: string | undefined): number | null {
  if (rawColumns === undefined || rawColumns.trim() === "") {
    return null;
  }

  const parsed = Number.parseInt(rawColumns, 10);
  return normalizeColumns(parsed);
}

function normalizeColumns(columns: number | undefined | null): number | null {
  if (columns === undefined || columns === null || !Number.isFinite(columns) || columns <= 0) {
    return null;
  }

  return Math.floor(columns);
}
