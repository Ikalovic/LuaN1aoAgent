export const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1_000;

/** Tool inputs come from JSON. Never authorize a display-only prefix. */
export function serializeToolArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  if (text === undefined) throw new Error("Tool arguments are not JSON serializable");
  return text;
}
