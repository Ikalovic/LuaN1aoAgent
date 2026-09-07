import assert from "node:assert/strict";
import test from "node:test";
import { ToolApprovalRegistry } from "../src/approval/tool-approval-registry.js";

type AuditEvent = { taskId?: string; eventType: string; payload: Record<string, unknown> };

function auditCollector(): { events: AuditEvent[]; executionLog: { append: (input: AuditEvent) => Promise<void> } } {
  const events: AuditEvent[] = [];
  const executionLog = {
    append: async (input: AuditEvent) => { events.push(input); }
  };
  return { events, executionLog };
}

function context(runtimeDir = "run-a", runId = "run:1") {
  return {
    runId,
    runtimeDir,
    taskId: "task:1",
    taskGoal: "Test the authorized target",
    scopeSummary: "10.0.0.0/24"
  };
}

test("submit exposes a pending approval and resolves on decide", async () => {
  const registry = new ToolApprovalRegistry();
  const decision = registry.submit({
    context: context(),
    toolName: "bash",
    toolArgs: { command: "whoami" },
    intent: "执行单点命令",
    riskLevel: "medium",
    reason: "shell 执行需要人工确认"
  });

  const pending = registry.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, "bash");
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].intent, "执行单点命令");
  assert.equal(pending[0].taskGoal, "Test the authorized target");
  assert.equal(registry.pendingCount, 1);

  assert.equal(registry.decide(pending[0].id, "approve"), true);
  assert.equal(await decision, "approve");
  assert.equal(registry.list().length, 0);
  assert.equal(registry.pendingCount, 0);
});

test("deciding an unknown or already-decided approval fails", async () => {
  const registry = new ToolApprovalRegistry();
  const decision = registry.submit({
    context: context(),
    toolName: "write",
    toolArgs: { path: "/tmp/x" },
    riskLevel: "low"
  });
  assert.equal(registry.decide("missing-id", "approve"), false);
  const [pending] = registry.list();
  assert.equal(registry.decide(pending.id, "deny"), true);
  assert.equal(registry.decide(pending.id, "approve"), false);
  assert.equal(await decision, "deny");
});

test("list filters by runtimeDir and keeps newest first", async () => {
  let now = 1_000;
  const registry = new ToolApprovalRegistry({ now: () => now });
  const first = registry.submit({ context: context("run-a"), toolName: "bash", toolArgs: {}, riskLevel: "low" });
  now = 2_000;
  const second = registry.submit({ context: context("run-b"), toolName: "write", toolArgs: {}, riskLevel: "low" });
  now = 3_000;
  const third = registry.submit({ context: context("run-a"), toolName: "replay_http", toolArgs: {}, riskLevel: "high" });

  const all = registry.list();
  assert.deepEqual(all.map((item) => item.runtimeDir), ["run-a", "run-b", "run-a"]);
  assert.equal(all[2].riskLevel, "high");
  const runA = registry.list({ runtimeDir: "run-a" });
  assert.deepEqual(runA.map((item) => item.toolName), ["bash", "replay_http"]);

  const ids = all.map((item) => item.id);
  for (const id of ids) registry.decide(id, "deny");
  await Promise.all([first, second, third]);
});

test("settleRun denies everything still pending for the run", async () => {
  const registry = new ToolApprovalRegistry();
  const a = registry.submit({ context: context("run-a", "run:1"), toolName: "bash", toolArgs: {}, riskLevel: "low" });
  const b = registry.submit({ context: context("run-b", "run:2"), toolName: "bash", toolArgs: {}, riskLevel: "low" });

  assert.equal(registry.settleRun("run:1"), 1);
  assert.equal(await a, "deny");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.settleRun("run:1"), 0);
  assert.equal(registry.decide(registry.list()[0].id, "approve"), true);
  assert.equal(await b, "approve");
});

test("requests and decisions are written to the execution log", async () => {
  const { events, executionLog } = auditCollector();
  const registry = new ToolApprovalRegistry({
    executionLogProvider: () => executionLog as never
  });
  const decision = registry.submit({
    context: context(),
    toolName: "bash",
    toolArgs: { command: "id" },
    riskLevel: "high"
  });
  const [pending] = registry.list();
  registry.decide(pending.id, "deny");
  await decision;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const requested = events.find((event) => event.eventType === "tool_approval_requested");
  assert.ok(requested);
  assert.equal(requested!.taskId, "task:1");
  assert.equal(requested!.payload.toolName, "bash");
  assert.equal(requested!.payload.riskLevel, "high");
  assert.equal(requested!.payload.pending, true);
  const decided = events.find((event) => event.eventType === "tool_approval_decided");
  assert.ok(decided);
  assert.equal(decided!.payload.decision, "deny");
});

test("toolArgs are summarized into JSON text and truncated", () => {
  const registry = new ToolApprovalRegistry();
  void registry.submit({
    context: context(),
    toolName: "write",
    toolArgs: { path: "/tmp/a", content: "hello" },
    riskLevel: "low"
  });
  const [pending] = registry.list();
  assert.equal(typeof pending.toolArgs, "string");
  const parsed = JSON.parse(pending.toolArgs);
  assert.equal(parsed.path, "/tmp/a");
  assert.equal(parsed.content, "hello");
});
