/** Shared strict T3 wire predicates; presentation screening remains separate. */
export const T3_SESSION_SCOPES: readonly string[] = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "relay:write",
  "access:read",
  "access:write",
];

export const t3WireText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

export const t3WireTimestamp = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  )
    return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"))
  );
};
