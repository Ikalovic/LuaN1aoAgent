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

  assert.equal(await registry.decide(pending[0].id, "approve"), true);
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
  assert.equal(await registry.decide("missing-id", "approve"), false);
  const [pending] = registry.list();
  assert.equal(await registry.decide(pending.id, "deny"), true);
  assert.equal(await registry.decide(pending.id, "approve"), false);
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
  for (const id of ids) await registry.decide(id, "deny");
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
  assert.equal(await registry.decide(registry.list()[0].id, "approve"), true);
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
  await registry.decide(pending.id, "deny");
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

test("toolArgs preserve the complete JSON payload", () => {
  const registry = new ToolApprovalRegistry();
  void registry.submit({
    context: context(),
    toolName: "write",
    toolArgs: { path: "/tmp/a", content: "x".repeat(9_000) + " TAIL" },
    riskLevel: "low"
  });
  const [pending] = registry.list();
  assert.equal(typeof pending.toolArgs, "string");
  const parsed = JSON.parse(pending.toolArgs);
  assert.equal(parsed.path, "/tmp/a");
  assert.equal(parsed.content, "x".repeat(9_000) + " TAIL");
  registry.settleRun("run:1");
});

test("approval waits for decision audit persistence", async () => {
  let persist!: () => void;
  const persisted = new Promise<void>((resolve) => { persist = resolve; });
  const registry = new ToolApprovalRegistry({ executionLogProvider: () => ({
    append: async (event: AuditEvent) => {
      if (event.eventType === "tool_approval_decided") await persisted;
    }
  }) as never });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  let resolved = false;
  void decision.then(() => { resolved = true; });
  const deciding = registry.decide(registry.list()[0].id, "approve");
  await new Promise<void>((resolve) => setImmediate(resolve));
  try { assert.equal(resolved, false); }
  finally { persist(); }
  await deciding;
  assert.equal(await decision, "approve");
});

test("audit failure denies execution", async () => {
  const registry = new ToolApprovalRegistry({ executionLogProvider: () => ({
    append: async () => { throw new Error("disk unavailable"); }
  }) as never });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  await registry.decide(registry.list()[0].id, "approve");
  assert.equal(await decision, "deny");
});

test("configured but missing audit storage denies execution", async () => {
  const registry = new ToolApprovalRegistry({ executionLogProvider: () => undefined });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  assert.equal(await registry.decide(registry.list()[0].id, "approve"), false);
  assert.equal(await decision, "deny");
});

test("a failed decision write never releases execution", async () => {
  const registry = new ToolApprovalRegistry({ executionLogProvider: () => ({
    append: async (event: AuditEvent) => {
      if (event.eventType === "tool_approval_decided") throw new Error("disk full");
    }
  }) as never });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  assert.equal(await registry.decide(registry.list()[0].id, "approve"), false);
  assert.equal(await decision, "deny");
});

test("cancellation wins over an approval still being persisted and duplicate decisions", async () => {
  let persist!: () => void;
  const storage = new Promise<void>((resolve) => { persist = resolve; });
  const registry = new ToolApprovalRegistry({ executionLogProvider: () => ({
    append: async (event: AuditEvent) => {
      if (event.eventType === "tool_approval_decided") await storage;
    }
  }) as never });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  const id = registry.list()[0].id;
  const deciding = registry.decide(id, "approve");
  assert.equal(await registry.decide(id, "approve"), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(registry.settleRun("run:1"), 1);
  assert.equal(await decision, "deny");
  persist();
  assert.equal(await deciding, false);
});

test("expired approvals cannot execute even before the timer callback runs", async () => {
  let now = 1_000;
  const registry = new ToolApprovalRegistry({ now: () => now, approvalTimeoutMs: 100 });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  const pending = registry.list()[0];
  assert.equal(pending.expiresAt, new Date(1_100).toISOString());
  assert.match(pending.payloadHash, /^[0-9a-f]{64}$/);
  now = 1_100;
  assert.equal(await registry.decide(pending.id, "approve"), false);
  assert.equal(await decision, "deny");
});

test("approval timer expires without an operator or polling", async () => {
  const registry = new ToolApprovalRegistry({ approvalTimeoutMs: 5 });
  const decision = registry.submit({ context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registry.pendingCount, 0);
  assert.equal(await decision, "deny");
});

test("task abort denies pending and late submissions", async () => {
  const registry = new ToolApprovalRegistry();
  const abort = new AbortController();
  const input = { context: context(), toolName: "bash", toolArgs: {}, riskLevel: "high" as const, signal: abort.signal };
  const decision = registry.submit(input);
  abort.abort();
  assert.equal(await decision, "deny");
  assert.equal(await registry.submit(input), "deny");
  assert.equal(registry.pendingCount, 0);
});
