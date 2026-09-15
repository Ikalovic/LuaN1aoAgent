import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readJsonlWithCoverage, boundedCollection, reconstructedCoverage } from "../src/runtime-coverage.js";

test("JSONL coverage distinguishes raw truncation, parse failures, timestamp order, missing, empty, and unreadable", async () => {
  const root = await mkdtemp("/tmp/coverage-");
  const file = join(root, "events.jsonl");
  try {
    assert.deepEqual((await readJsonlWithCoverage(file, 2)).coverage, {
      source: "jsonl", state: "unavailable", returned: 0, limit: 2, truncated: null, skippedRecords: 0, reason: "missing"
    });
    await writeFile(file, "\n");
    assert.equal((await readJsonlWithCoverage(file, 2)).coverage.state, "complete");
    await writeFile(file, '{"timestamp":"2026-01-02"}\n{"timestamp":"2026-01-01"}\n');
    const exact = await readJsonlWithCoverage(file, 2);
    assert.equal(exact.coverage.truncated, false);
    assert.equal(exact.coverage.firstTimestamp, "2026-01-01T00:00:00.000Z");
    assert.equal(exact.coverage.lastTimestamp, "2026-01-02T00:00:00.000Z");
    await writeFile(file, '{}\n{}\nmalformed\n');
    const tail = await readJsonlWithCoverage(file, 2);
    assert.equal(tail.records.length, 1);
    assert.equal(tail.coverage.truncated, true);
    assert.equal(tail.coverage.skippedRecords, 1);
    assert.equal(tail.coverage.state, "partial");
    assert.equal(tail.coverage.reason, "parse_error");
    await writeFile(file, 'malformed\nnull\n');
    assert.equal((await readJsonlWithCoverage(file, 2)).coverage.state, "partial");
    assert.equal((await readJsonlWithCoverage(root, 2)).coverage.reason, "read_error");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded SQLite reads distinguish exact limit and sentinel, and account for skipped selected rows", () => {
  const parse = (row: number): number[] => row < 0 ? [] : [row];
  assert.equal(boundedCollection([1, 2], 2, parse).coverage.state, "complete");
  const over = boundedCollection([1, -1, 3], 2, parse);
  assert.deepEqual(over.records, [1]);
  assert.equal(over.coverage.truncated, true);
  assert.equal(over.coverage.returned, 1);
  assert.equal(over.coverage.skippedRecords, 1);
  assert.equal(over.coverage.state, "partial");
});

test("delta reconstruction never claims complete nodes or confuses delta and node limits", () => {
  const delta = { source: "jsonl" as const, state: "complete" as const, returned: 1, limit: 260, truncated: false, skippedRecords: 0 };
  assert.deepEqual(reconstructedCoverage(1400, delta), { source: "graph-deltas", state: "unknown", returned: 1400, limit: null, truncated: null, skippedRecords: 0, reason: "fallback" });
  assert.equal(reconstructedCoverage(0, { ...delta, state: "unavailable", reason: "missing" }).state, "unavailable");
  assert.equal(reconstructedCoverage(10, { ...delta, state: "partial", truncated: true }).state, "partial");
  assert.equal(reconstructedCoverage(2, delta, [{ updatedAt: "2026-01-02" }, { updatedAt: "2026-01-01" }]).firstTimestamp, "2026-01-01T00:00:00.000Z");
});
