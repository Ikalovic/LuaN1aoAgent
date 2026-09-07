import assert from "node:assert/strict";
import test from "node:test";
import { LlmJudgeUnavailableError } from "../src/approval/llm-risk-judge.js";
import {
  ToolApprovalRegistry,
  type ApprovalDecision
} from "../src/approval/tool-approval-registry.js";
import {
  createToolApprovalExtension,
  type TerminalApprover
} from "../src/approval/tool-approval-extension.js";

type ToolCallHandler = (event: { toolName?: string; input?: unknown }, ctx: unknown) => Promise<unknown>;

function harness() {
  const handlers = new Map<string, ToolCallHandler>();
  const pi = {
    on: (eventName: string, handler: ToolCallHandler) => {
      handlers.set(eventName, handler);
      return pi;
    }
  };
  return { pi, handlers };
}

function invoke(handlers: Map<string, ToolCallHandler>, toolName: string, input: unknown): Promise<unknown> {
  const handler = handlers.get("tool_call");
  assert.ok(handler, "tool_call handler must be registered");
  return handler!({ toolName, input }, {});
}

function judgeMock(verdicts: Record<string, unknown> = {}) {
  const calls: Array<{ toolName: string; forcedVerdict?: string }> = [];
  const judge = {
    assess: async (input: { toolName: string; forcedVerdict?: string }) => {
      calls.push({ toolName: input.toolName, forcedVerdict: input.forcedVerdict });
      const preset = verdicts[input.toolName];
      if (preset instanceof Error) throw preset;
      if (preset) return preset;
      return { verdict: "allow", intent: "常规操作", riskLevel: "low", reason: "无明显风险" };
    }
  };
  return { judge, calls };
}

function registryMock() {
  const submissions: Array<{ toolName: string; intent?: string }> = [];
  const registry = {
    submit: async (input: { toolName: string; intent?: string }) => {
      submissions.push({ toolName: input.toolName, intent: input.intent });
      return "deny" as ApprovalDecision;
    }
  } as unknown as ToolApprovalRegistry;
  return { registry, submissions };
}

const context = {
  runId: "run:1",
  runtimeDir: "run-a",
  taskId: "task:1",
  taskGoal: "Find the flag",
  scopeSummary: "10.0.0.0/24"
};

test("off mode never gates any tool call", async () => {
  const { pi, handlers } = harness();
  createToolApprovalExtension({ mode: "off", context })(pi as never);
  assert.equal(await invoke(handlers, "bash", { command: "id" }), undefined);
  assert.equal(await invoke(handlers, "read", {}), undefined);
});

test("auto mode passes read-only tools through without judging", async () => {
  const { pi, handlers } = harness();
  const { judge, calls } = judgeMock();
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never })(pi as never);
  assert.equal(await invoke(handlers, "grep", { pattern: "flag" }), undefined);
  assert.deepEqual(calls, []);
});

test("auto mode lets a judge-allowed call run", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock();
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never })(pi as never);
  assert.equal(await invoke(handlers, "web_fetch", { url: "http://10.0.0.5/" }), undefined);
});

test("auto mode submits judge-flagged calls to the registry and denies blocks", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock({
    bash: { verdict: "require_approval", intent: "执行系统命令", riskLevel: "high", reason: "shell 执行" }
  });
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never, registry })(pi as never);

  const result = await invoke(handlers, "bash", { command: "whoami" });
  assert.deepEqual(submissions, [{ toolName: "bash", intent: "执行系统命令" }]);
  assert.deepEqual(result, {
    block: true,
    reason: "危险操作 bash（意图：执行系统命令）未被批准：shell 执行"
  });
});

test("auto mode falls back to the static dangerous list when the judge fails", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock({ bash: new LlmJudgeUnavailableError("judge down") });
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never, registry })(pi as never);

  await invoke(handlers, "bash", {});
  assert.deepEqual(submissions.map((item) => item.toolName), ["bash"]);

  // Unknown tool + unavailable judge: allowed (conservative fallback allows unknowns).
  const result = await invoke(handlers, "some_future_tool", {});
  assert.equal(result, undefined);
  assert.equal(submissions.length, 1);
});

test("auto mode without a judge submits non-readonly tools for approval", async () => {
  const { pi, handlers } = harness();
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({ mode: "auto", context, registry })(pi as never);
  await invoke(handlers, "write", { path: "/tmp/x" });
  assert.deepEqual(submissions.map((item) => item.toolName), ["write"]);
});

test("strict mode requires approval for every call and generates intent", async () => {
  const { pi, handlers } = harness();
  const { judge, calls } = judgeMock({
    read: { verdict: "allow", intent: "读取配置文件", riskLevel: "low", reason: "" }
  });
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({ mode: "strict", context, judge: judge as never, registry })(pi as never);

  await invoke(handlers, "read", { path: "/etc/hosts" });
  assert.deepEqual(calls, [{ toolName: "read", forcedVerdict: "require_approval" }]);
  assert.deepEqual(submissions, [{ toolName: "read", intent: "读取配置文件" }]);
});

test("deny by default when no decision interface is configured", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock({
    bash: { verdict: "require_approval", intent: "执行系统命令", riskLevel: "high", reason: "shell 执行" }
  });
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never })(pi as never);
  const result = await invoke(handlers, "bash", {});
  assert.ok(result && typeof result === "object");
  const blocked = result as { block?: boolean; reason?: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /未被批准/);
});

test("terminal approver decides instead of the registry", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock({
    bash: { verdict: "require_approval", intent: "执行系统命令", riskLevel: "high", reason: "shell 执行" }
  });
  const approvals: string[] = [];
  const terminalApprover: TerminalApprover = async (input) => {
    approvals.push(input.toolName);
    return "approve";
  };
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never, terminalApprover })(pi as never);
  assert.equal(await invoke(handlers, "bash", { command: "id" }), undefined);
  assert.deepEqual(approvals, ["bash"]);
});

test("block reason includes the tool name and judge reason when denied", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock({
    replay_http: { verdict: "require_approval", intent: "重放捕获的请求", riskLevel: "medium", reason: "重放可能重复修改状态" }
  });
  const registry = {
    submit: async () => "deny" as ApprovalDecision
  } as unknown as ToolApprovalRegistry;
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never, registry })(pi as never);
  const result = await invoke(handlers, "replay_http", { exchangeId: "e1" }) as { block: boolean; reason: string };
  assert.equal(result.block, true);
  assert.match(result.reason, /replay_http/);
  assert.match(result.reason, /重放可能重复修改状态/);
});

test("a mode getter is read on every tool call so live switches take effect", async () => {
  const { pi, handlers } = harness();
  let currentMode: "off" | "auto" | "strict" = "off";
  const { judge } = judgeMock();
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({ mode: () => currentMode, context, judge: judge as never, registry })(pi as never);

  // off: everything passes through without touching the registry.
  assert.equal(await invoke(handlers, "bash", { command: "id" }), undefined);
  assert.equal(submissions.length, 0);

  // Live switch to strict: every call now requires approval.
  currentMode = "strict";
  await invoke(handlers, "read", { path: "/etc/hosts" });
  assert.deepEqual(submissions.map((item) => item.toolName), ["read"]);

  // Live switch to auto: read-only passes, judge allows bash.
  currentMode = "auto";
  assert.equal(await invoke(handlers, "grep", {}), undefined);
  assert.equal(await invoke(handlers, "bash", { command: "id" }), undefined);
  assert.equal(submissions.length, 1);
});

test("a lazy judge getter defers judge creation until a mode needs it", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock();
  const { registry, submissions } = registryMock();
  let currentMode: "off" | "auto" = "off";
  let judgeRequests = 0;
  createToolApprovalExtension({
    mode: () => currentMode,
    context,
    judge: async () => {
      judgeRequests += 1;
      return judge as never;
    },
    registry
  })(pi as never);

  // off: the judge getter is never invoked.
  assert.equal(await invoke(handlers, "bash", {}), undefined);
  assert.equal(judgeRequests, 0);

  // auto after a live switch: the judge getter runs once and the call passes.
  currentMode = "auto";
  assert.equal(await invoke(handlers, "bash", {}), undefined);
  assert.equal(judgeRequests, 1);
  assert.equal(submissions.length, 0);
});
