export function normalizeGeneratedSource(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
