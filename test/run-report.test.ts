import assert from "node:assert/strict";
import test from "node:test";
import { deriveFinalReport } from "../src/run-report.js";
import type { ArtifactRecord, TaskOutcome } from "../src/types.js";

function outcome(input: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    taskRef: "task:report",
    epochRef: "epoch:report:1",
    status: "completed",
    summary: "Final report generated",
    evidenceRefs: [],
    artifactRefs: ["artifact:report"],
    capabilityRefs: [],
    terminalSeq: 10,
    createdAt: "2026-08-05T01:00:10.000Z",
    ...input
  };
}

function artifact(input: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactRef: "artifact:report",
    taskId: "task:report",
    kind: "report",
    mediaType: "text/markdown",
    path: "/tmp/artifacts/final-report.md",
    byteLength: 128,
    contentHash: "report-hash",
    createdAt: "2026-08-05T01:00:09.000Z",
    preview: "# Final report",
    ...input
  };
}

test("derives the latest completed TaskOutcome that references a report Artifact", () => {
  const result = deriveFinalReport(
    [
      outcome({ taskRef: "task:older", terminalSeq: 4 }),
      outcome({ taskRef: "task:latest", terminalSeq: 12 })
    ],
    [artifact()]
  );

  assert.equal(result?.taskRef, "task:latest");
  assert.deepEqual(result?.artifactRefs, ["artifact:report"]);
  assert.equal(result?.artifacts[0]?.kind, "report");
});

test("does not treat ordinary artifacts as a final report", () => {
  assert.equal(
    deriveFinalReport([outcome()], [artifact({ kind: "text" })]),
    undefined
  );
});

test("does not treat a partial report TaskOutcome as a final report", () => {
  assert.equal(
    deriveFinalReport([outcome({ status: "partial" })], [artifact()]),
    undefined
  );
});
