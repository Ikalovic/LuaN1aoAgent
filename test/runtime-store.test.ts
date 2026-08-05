import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getOrCreateRuntimeRunRef, RuntimeStore } from "../src/stores/runtime-store.js";

test("preserves the run reference when reopening a runtime", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  const firstRunRef = firstStore.getOrCreateRunRef();
  firstStore.close();

  const reopenedStore = new RuntimeStore(databasePath);
  assert.equal(reopenedStore.getOrCreateRunRef(), firstRunRef);
  reopenedStore.close();
});

test("reads the persistent run reference without recovering active runtime state", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const store = new RuntimeStore(databasePath);
  store.createEpoch({ epochId: "epoch:active", taskId: "task:active", attempt: 1 });
  store.transitionEpoch({ epochId: "epoch:active", state: "running" });

  assert.equal(getOrCreateRuntimeRunRef(databasePath), store.getOrCreateRunRef());
  assert.equal(store.getEpoch("epoch:active")?.state, "running");
  store.close();
});

test("transfers one Executor session and workspace to a single successor", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.upsertExecutorSession({
    taskId: "task:source",
    sessionFile: "/runtime/executor-sessions/source.jsonl",
    workspaceKey: "task:workspace-origin",
    resumeCount: 3
  });

  const transferred = store.transferExecutorSession("task:source", "task:successor");

  assert.equal(store.getExecutorSession("task:source"), undefined);
  assert.deepEqual(transferred, store.getExecutorSession("task:successor"));
  assert.equal(transferred.sessionFile, "/runtime/executor-sessions/source.jsonl");
  assert.equal(transferred.workspaceKey, "task:workspace-origin");
  assert.equal(transferred.resumeCount, 3);
  assert.throws(
    () => store.transferExecutorSession("task:source", "task:other"),
    /Executor session transfer failed/
  );
  store.close();
});

test("migrates legacy Executor sessions with their original task workspace key", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE executor_sessions (
      task_id TEXT PRIMARY KEY,
      session_file TEXT NOT NULL,
      resume_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO executor_sessions (task_id, session_file, resume_count, updated_at)
    VALUES ('task:legacy', '/runtime/legacy.jsonl', 2, '2026-08-04T00:00:00.000Z');
  `);
  database.close();

  const store = new RuntimeStore(databasePath);
  assert.equal(store.getExecutorSession("task:legacy")?.workspaceKey, "task:legacy");
  store.close();
});

test("tracks multiple epochs for one task without shared lifecycle state", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.createEpoch({ epochId: "epoch:1", taskId: "task:test", attempt: 1 });
  store.transitionEpoch({ epochId: "epoch:1", state: "running" });
  store.transitionEpoch({ epochId: "epoch:1", state: "closed", terminationReason: "budget_exhausted" });
  store.createEpoch({ epochId: "epoch:2", taskId: "task:test", attempt: 2 });

  assert.equal(store.countTaskEpochs("task:test"), 2);
  assert.equal(store.getEpoch("epoch:1")?.terminationReason, "budget_exhausted");
  assert.equal(store.getEpoch("epoch:2")?.state, "created");
  assert.deepEqual(store.stats(), {
    epochCount: 2,
    activeEpochCount: 1,
    byState: { closed: 1, created: 1 },
    byTerminationReason: { budget_exhausted: 1, none: 1 }
  });
});

test("counts task turns cumulatively across epochs and idempotently by event", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);

  assert.equal(firstStore.recordTaskTurn({ taskId: "task:test", eventId: "event:1" }), 1);
  assert.equal(firstStore.recordTaskTurn({ taskId: "task:test", eventId: "event:1" }), 1);
  assert.equal(firstStore.recordTaskTurn({ taskId: "task:test", eventId: "event:2" }), 2);
  assert.equal(firstStore.recordTaskTurn({ taskId: "task:other", eventId: "event:3" }), 1);
  firstStore.close();

  const reopenedStore = new RuntimeStore(databasePath);
  assert.equal(reopenedStore.getTaskConsumedTurns("task:test"), 2);
  assert.equal(reopenedStore.recordTaskTurn({ taskId: "task:test", eventId: "event:4" }), 3);
  assert.equal(reopenedStore.getTaskConsumedTurns("task:other"), 1);
  reopenedStore.close();
});

test("persists EpochOutcome independently from semantic TaskOutcome", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  firstStore.upsertEpochOutcome({
    epochRef: "epoch:provider-error",
    taskRef: "task:test",
    status: "provider_error",
    reason: "429 Too Many Requests",
    terminalSeq: 12,
    retryable: true,
    createdAt: "2026-07-31T00:00:00.000Z"
  });

  assert.equal(firstStore.getTaskOutcome("task:test"), undefined);
  firstStore.close();

  const reopenedStore = new RuntimeStore(databasePath);
  assert.deepEqual(reopenedStore.getEpochOutcome("epoch:provider-error"), {
    epochRef: "epoch:provider-error",
    taskRef: "task:test",
    status: "provider_error",
    reason: "429 Too Many Requests",
    terminalSeq: 12,
    retryable: true,
    createdAt: "2026-07-31T00:00:00.000Z"
  });
  assert.deepEqual(
    reopenedStore.listTaskEpochOutcomes("task:test").map((outcome) => outcome.epochRef),
    ["epoch:provider-error"]
  );
  assert.equal(reopenedStore.getTaskOutcome("task:test"), undefined);
  reopenedStore.close();
});

test("persists the epoch budget ledger across runtime reopening", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  firstStore.createEpoch({ epochId: "epoch:budget", taskId: "task:budget", attempt: 1 });
  firstStore.transitionEpoch({ epochId: "epoch:budget", state: "running" });
  firstStore.upsertEpochBudget({
    epochId: "epoch:budget",
    timeLimitMs: 60_000,
    deadlineAt: 70_000,
    pausedAt: 15_000,
    accumulatedPauseMs: 5_000
  });
  firstStore.close();

  const reopenedStore = new RuntimeStore(databasePath);
  assert.deepEqual(reopenedStore.getEpochBudget("epoch:budget"), {
    epochId: "epoch:budget",
    timeLimitMs: 60_000,
    deadlineAt: 70_000,
    pausedAt: 15_000,
    accumulatedPauseMs: 5_000
  });
  assert.equal(reopenedStore.getEpoch("epoch:budget")?.terminationReason, "shutdown");
  reopenedStore.close();
});

test("projection desired sequence does not advance committed sequence", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.raiseProjectionDesired("task:test", 3);
  store.raiseProjectionDesired("task:test", 9);
  const claim = store.claimProjection("task:test");

  assert.deepEqual(claim, { taskId: "task:test", fromSeq: 0, toSeq: 9, generation: 1 });
  assert.equal(store.getProjectionState("task:test").committedSeq, 0);
});

test("releases interrupted projection claims without advancing committed sequence", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  firstStore.raiseProjectionDesired("task:test", 9);
  assert.ok(firstStore.claimProjection("task:test"));
  firstStore.close();

  const recoveredStore = new RuntimeStore(databasePath);
  const state = recoveredStore.getProjectionState("task:test");

  assert.equal(recoveredStore.recoveredProjectionClaims, 1);
  assert.equal(state.activeGeneration, undefined);
  assert.equal(state.committedSeq, 0);
  assert.equal(state.desiredSeq, 9);
  assert.deepEqual(recoveredStore.listPendingProjectionTasks().map((item) => item.taskId), ["task:test"]);
  recoveredStore.close();
});

test("persists projection age and terminal fence across recovery", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  const raised = firstStore.raiseProjectionDesired("task:test", 12, 10, 12);

  assert.ok(raised.pendingSince);
  assert.equal(raised.terminalTargetSeq, 12);
  firstStore.close();

  const recoveredStore = new RuntimeStore(databasePath);
  const recovered = recoveredStore.getProjectionState("task:test");
  assert.equal(recovered.pendingSince, raised.pendingSince);
  assert.equal(recovered.terminalTargetSeq, 12);

  recoveredStore.clearProjectionTerminalTarget("task:test", 12);
  assert.equal(recoveredStore.getProjectionState("task:test").terminalTargetSeq, undefined);
  recoveredStore.close();
});

test("lists a caught-up terminal fence until the coordinator acknowledges it", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.raiseProjectionDesired("task:terminal-association", 4, 10, 4);
  const claim = store.claimProjection("task:terminal-association");
  assert.ok(claim);
  store.releaseProjection("task:terminal-association", claim.generation);
  const secondClaim = store.claimProjection("task:terminal-association");
  assert.ok(secondClaim);

  const database = new DatabaseSync(store.databasePath);
  database.prepare(`
    UPDATE projection_states
    SET committed_seq = desired_seq, active_generation = NULL
    WHERE task_id = ?
  `).run("task:terminal-association");
  database.close();

  assert.deepEqual(
    store.listPendingProjectionTasks().map((state) => state.taskId),
    ["task:terminal-association"]
  );
  store.clearProjectionTerminalTarget("task:terminal-association", 4);
  assert.deepEqual(store.listPendingProjectionTasks(), []);
  store.close();
});

test("keeps the latest complete task outcome for dependency handoff", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runtime-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const store = new RuntimeStore(databasePath);
  store.upsertTaskOutcome({
    taskRef: "task:test",
    epochRef: "epoch:1",
    status: "partial",
    summary: "initial foothold",
    evidenceRefs: ["event:1"],
    artifactRefs: ["artifact:1"],
    capabilityRefs: ["route:1"],
    blockerReason: "Need a stable command execution primitive",
    checkpoint: { reason: "resume from foothold", resumeCursor: "artifact:1" },
    terminalSeq: 8,
    createdAt: "2026-07-25T00:00:00.000Z"
  });
  assert.equal(
    store.getTaskOutcome("task:test")?.blockerReason,
    "Need a stable command execution primitive"
  );
  store.upsertTaskOutcome({
    taskRef: "task:test",
    epochRef: "epoch:2",
    status: "completed",
    summary: "verified access",
    evidenceRefs: ["event:2"],
    artifactRefs: ["artifact:2"],
    capabilityRefs: ["route:1", "connection:1"],
    terminalSeq: 18,
    createdAt: "2026-07-25T00:01:00.000Z"
  });

  assert.deepEqual(store.getTaskOutcome("task:test"), {
    taskRef: "task:test",
    epochRef: "epoch:2",
    status: "completed",
    summary: "verified access",
    evidenceRefs: ["event:2"],
    artifactRefs: ["artifact:2"],
    capabilityRefs: ["route:1", "connection:1"],
    terminalSeq: 18,
    createdAt: "2026-07-25T00:01:00.000Z"
  });
  assert.deepEqual(store.listTaskOutcomes(1).map((outcome) => outcome.taskRef), ["task:test"]);
  store.close();
});
