import { readFile } from "node:fs/promises";

export interface CollectionCoverage {
  source: "sqlite" | "jsonl" | "graph-deltas";
  state: "complete" | "partial" | "unknown" | "unavailable";
  returned: number;
  limit: number | null;
  truncated: boolean | null;
  skippedRecords: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  reason?: "missing" | "read_error" | "parse_error" | "fallback";
}

export interface CoveredCollection<T> { records: T[]; coverage: CollectionCoverage }

function timestampRange(records: unknown[]): Pick<CollectionCoverage, "firstTimestamp" | "lastTimestamp"> {
  const timestamps = records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const fields = record as Record<string, unknown>;
    const value = fields.timestamp ?? fields.createdAt ?? fields.updatedAt;
    const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? [timestamp] : [];
  }).sort((a, b) => a - b);
  return timestamps.length ? { firstTimestamp: new Date(timestamps[0]).toISOString(), lastTimestamp: new Date(timestamps[timestamps.length - 1]).toISOString() } : {};
}

export function unavailableCoverage(source: CollectionCoverage["source"], limit: number | null, reason: "missing" | "read_error"): CollectionCoverage {
  return { source, state: "unavailable", returned: 0, limit, truncated: null, skippedRecords: 0, reason };
}

// Callers fetch LIMIT + 1. The extra row establishes truncation without being parsed.
export function boundedCollection<Row, T>(rows: Row[], limit: number, normalize: (row: Row) => T[]): CoveredCollection<T> {
  const selected = rows.slice(0, limit);
  const records: T[] = [];
  let skippedRecords = 0;
  for (const row of selected) {
    try {
      const parsed = normalize(row);
      if (!parsed.length) skippedRecords++;
      records.push(...parsed);
    } catch { skippedRecords++; }
  }
  const truncated = rows.length > limit;
  return { records, coverage: { source: "sqlite", state: truncated || skippedRecords ? "partial" : "complete", returned: records.length,
    limit, truncated, skippedRecords, ...(skippedRecords ? { reason: "parse_error" as const } : {}), ...timestampRange(records) } };
}

export async function readJsonlWithCoverage<T>(filePath: string, limit: number): Promise<CoveredCollection<T>> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());
    const selected = lines.slice(-limit);
    const result = boundedCollection(selected, limit, (line): T[] => {
      const parsed: unknown = JSON.parse(line);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as T] : [];
    });
    const truncated = lines.length > limit;
    return { records: result.records, coverage: { ...result.coverage, source: "jsonl", truncated,
      state: truncated || result.coverage.skippedRecords ? "partial" : "complete" } };
  } catch (error) {
    return { records: [], coverage: unavailableCoverage("jsonl", limit, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read_error") };
  }
}

export function reconstructedCoverage(returned: number, deltas?: CollectionCoverage, records: unknown[] = []): CollectionCoverage {
  const state = deltas?.state === "unavailable" && !returned ? "unavailable" : deltas?.state === "partial" ? "partial" : "unknown";
  return { source: "graph-deltas", state, returned, limit: null, truncated: null, skippedRecords: deltas?.skippedRecords ?? 0, reason: "fallback", ...timestampRange(records) };
}
