import assert from "node:assert/strict";
import test from "node:test";
import { LlmJudgeUnavailableError } from "../src/approval/llm-risk-judge.js";
import {
  ToolApprovalRegistry,
  type ApprovalDecision
} from "../src/approval/tool-approval-registry.js";
import {
  createStdinApprover,
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

test("auto mode requires approval for unknown tools when the judge fails", async () => {
  const { pi, handlers } = harness();
  const { judge } = judgeMock({
    bash: new LlmJudgeUnavailableError("judge down"),
    some_future_tool: new LlmJudgeUnavailableError("judge down")
  });
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({ mode: "auto", context, judge: judge as never, registry })(pi as never);

  await invoke(handlers, "bash", {});
  assert.deepEqual(submissions.map((item) => item.toolName), ["bash"]);

  const result = await invoke(handlers, "some_future_tool", {});
  assert.equal((result as { block: boolean }).block, true);
  assert.equal(submissions.length, 2);
});

test("lazy judge initialization failure falls back to manual approval", async () => {
  const { pi, handlers } = harness();
  const { registry, submissions } = registryMock();
  createToolApprovalExtension({
    mode: "auto", context, registry,
    judge: async () => { throw new Error("initialization failed"); }
  })(pi as never);
  const result = await invoke(handlers, "some_future_tool", {});
  assert.equal((result as { block: boolean }).block, true);
  assert.equal(submissions.length, 1);
});

test("manual approval sees the complete payload and cannot authorize mutated arguments", async () => {
  const { pi, handlers } = harness();
  const args = { command: "x".repeat(9_000) + " ORIGINAL_TAIL" };
  const original = args.command;
  let reviewed = "";
  createToolApprovalExtension({
    mode: "strict", context,
    terminalApprover: async (input) => {
      reviewed = input.toolArgs;
      args.command = "changed after review";
      return "approve";
    }
  })(pi as never);
  const result = await invoke(handlers, "bash", args);
  assert.equal(JSON.parse(reviewed).command, original);
  assert.equal((result as { block: boolean }).block, true);
});

test("judge approval cannot authorize arguments changed while judging", async () => {
  const { pi, handlers } = harness();
  const args = { command: "original" };
  createToolApprovalExtension({
    mode: "auto", context,
    judge: { assess: async () => {
      args.command = "changed";
      return { verdict: "allow", intent: "ok", riskLevel: "low", reason: "" };
    } } as never
  })(pi as never);
  const result = await invoke(handlers, "bash", args);
  assert.equal((result as { block: boolean }).block, true);
});

test("stop during judge wait promptly blocks and creates no late approval", async () => {
  const { pi, handlers } = harness();
  const abort = new AbortController();
  const { registry, submissions } = registryMock();
  let release!: (value: never) => void;
  const judge = new Promise<never>((resolve) => { release = resolve; });
  createToolApprovalExtension({ mode: "auto", context, registry, signal: abort.signal,
    judge: () => judge
  })(pi as never);
  const result = invoke(handlers, "bash", {});
  abort.abort();
  assert.equal((await result as { block: boolean }).block, true);
  release(undefined as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(submissions.length, 0);
});

test("a stricter live policy invalidates an in-flight judge allow", async () => {
  const { pi, handlers } = harness();
  let mode: "auto" | "strict" = "auto";
  createToolApprovalExtension({ mode: () => mode, context,
    judge: { assess: async () => {
      mode = "strict";
      return { verdict: "allow", intent: "ok", riskLevel: "low", reason: "" };
    } } as never
  })(pi as never);
  assert.equal((await invoke(handlers, "bash", {}) as { block: boolean }).block, true);
});

test("task cancellation clears a pending web approval", async () => {
  const { pi, handlers } = harness();
  const abort = new AbortController();
  const registry = new ToolApprovalRegistry();
  createToolApprovalExtension({ mode: "strict", context, registry, signal: abort.signal })(pi as never);
  const result = invoke(handlers, "bash", {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(registry.pendingCount, 1);
  abort.abort();
  assert.equal((await result as { block: boolean }).block, true);
  assert.equal(registry.pendingCount, 0);
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

test("the terminal approver fails closed instead of hanging on a non-interactive stdin", async () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalWrite = process.stderr.write.bind(process.stderr);
  const written: string[] = [];
  // A headless run cannot answer the y/N prompt. The approver must deny rather
  // than leave the Executor suspended forever — a credential-attack Agent hits
  // this on its first brute-force command.
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const approver = createStdinApprover();
    const decision = await Promise.race([
      approver({ toolName: "bash", toolArgs: "{}", riskLevel: "high" }),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2_000))
    ]);
    assert.equal(decision, "deny");
    assert.equal(written.some((line) => /stdin is not interactive/.test(line)), true);
    assert.equal(written.some((line) => /APPROVAL_MODE=off/.test(line)), true);
  } finally {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  }
});
