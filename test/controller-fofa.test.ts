import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { FofaMcpRuntimeOptions } from "../src/mcp/fofa-runtime.js";
import type { TaskEnvelope } from "../src/types.js";

type FakeFofaRuntime = {
  startCalls: number;
  closeCalls: number;
  invalidated: string[];
  start(): Promise<void>;
  call(): Promise<never>;
  invalidateTask(taskRef: string): void;
  close(): Promise<void>;
};

type ControllerFofaHarness = {
  configureFofaRuntime(scopeSummary: string): Promise<void>;
  createTaskRuntimeTools(task: TaskEnvelope): Array<{ name: string }>;
  invalidateFofaTaskIfTerminal(taskRef: string, status: string, retryable?: boolean): void;
};

test("Controller starts FOFA only after Scope and injects it into Task Executor tools", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "controller-fofa-"));
  let options: FofaMcpRuntimeOptions | undefined;
  const fake = fakeRuntime();
  const controller = createController(runtimeDir, {
    FOFA_API_KEY: "sentinel-secret",
    FOFA_API_BASE_URL: "https://fofa.example"
  }, (input) => {
    options = input;
    return fake as never;
  });
  const harness = controller as unknown as ControllerFofaHarness;
  assert.equal(fake.startCalls, 0);
  assert.ok(harness.createTaskRuntimeTools(taskEnvelope()).every((tool) => !tool.name.startsWith("fofa_")));

  await harness.configureFofaRuntime("example.com,192.0.2.0/24");
  assert.equal(fake.startCalls, 1);
  assert.deepEqual(options?.scope, { cidrs: ["192.0.2.0/24"], domains: ["example.com"] });
  assert.deepEqual(
    harness.createTaskRuntimeTools(taskEnvelope()).filter((tool) => tool.name.startsWith("fofa_")).map((tool) => tool.name).sort(),
    ["fofa_account_info", "fofa_host_aggregate", "fofa_search", "fofa_search_next", "fofa_stats"]
  );
  await controller.close({ drainProjectionJobs: false });
  assert.equal(fake.closeCalls, 1);
});

test("Controller leaves normal Executor tools available when FOFA is missing or malformed", async () => {
  for (const environment of [
    {},
    { FOFA_API_KEY: "sentinel-secret", FOFA_API_BASE_URL: "http://remote.example" }
  ]) {
    const runtimeDir = mkdtempSync(join(tmpdir(), "controller-fofa-disabled-"));
    let factoryCalls = 0;
    const controller = createController(runtimeDir, environment, () => {
      factoryCalls += 1;
      return fakeRuntime() as never;
    });
    const harness = controller as unknown as ControllerFofaHarness;
    await harness.configureFofaRuntime("example.com");
    const names = harness.createTaskRuntimeTools(taskEnvelope()).map((tool) => tool.name);
    assert.ok(names.includes("evidence_list"));
    assert.ok(names.every((name) => !name.startsWith("fofa_")));
    assert.equal(factoryCalls, 0);
    const events = (await controller.executionLog.window({ limit: 20 })).events;
    assert.doesNotMatch(JSON.stringify(events), /sentinel-secret/);
    await controller.close({ drainProjectionJobs: false });
  }
});

test("Controller skips FOFA when the Agent scope has no machine-readable asset", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "controller-fofa-scope-disabled-"));
  let factoryCalls = 0;
  const controller = createController(runtimeDir, { FOFA_API_KEY: "sentinel-secret" }, () => {
    factoryCalls += 1;
    return fakeRuntime() as never;
  });
  const harness = controller as unknown as ControllerFofaHarness;

  await harness.configureFofaRuntime("Authorized target only");

  assert.equal(factoryCalls, 0);
  assert.ok(harness.createTaskRuntimeTools(taskEnvelope()).every((tool) => !tool.name.startsWith("fofa_")));
  const events = (await controller.executionLog.window({ limit: 20 })).events;
  assert.ok(events.some((event) => event.eventType === "fofa_mcp_failed"));
  await controller.close({ drainProjectionJobs: false });
});

test("Controller stop closes FOFA and terminal Task states invalidate cursors", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "controller-fofa-stop-"));
  const fake = fakeRuntime();
  const controller = createController(runtimeDir, { FOFA_API_KEY: "sentinel-secret" }, () => fake as never);
  const harness = controller as unknown as ControllerFofaHarness;
  await harness.configureFofaRuntime("example.com");
  harness.invalidateFofaTaskIfTerminal("task:complete", "completed");
  harness.invalidateFofaTaskIfTerminal("task:retry", "failed", true);
  harness.invalidateFofaTaskIfTerminal("task:failed", "failed", false);
  assert.deepEqual(fake.invalidated, ["task:complete", "task:failed"]);
  await controller.requestStop("operator stop");
  assert.equal(fake.closeCalls, 1);
  await controller.close({ drainProjectionJobs: false });
});

function createController(
  runtimeDir: string,
  environment: NodeJS.ProcessEnv,
  factory: (input: FofaMcpRuntimeOptions) => never
): SecurityAgentController {
  const previous = {
    LLM_API_BASE_URL: process.env.LLM_API_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_DEFAULT_MODEL: process.env.LLM_DEFAULT_MODEL
  };
  process.env.LLM_API_BASE_URL = "https://example.test/api/openai";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_DEFAULT_MODEL = "test-model";
  try {
    return new SecurityAgentController({
      cwd: process.cwd(),
      runtimeDir,
      executorSandboxMode: "workspace",
      environment,
      fofaRuntimeFactory: factory
    });
  } finally {
    restore("LLM_API_BASE_URL", previous.LLM_API_BASE_URL);
    restore("LLM_API_KEY", previous.LLM_API_KEY);
    restore("LLM_DEFAULT_MODEL", previous.LLM_DEFAULT_MODEL);
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function fakeRuntime(): FakeFofaRuntime {
  return {
    startCalls: 0,
    closeCalls: 0,
    invalidated: [],
    async start() { this.startCalls += 1; },
    async call() { throw new Error("not called"); },
    invalidateTask(taskRef) { this.invalidated.push(taskRef); },
    async close() { this.closeCalls += 1; }
  };
}

function taskEnvelope(): TaskEnvelope {
  return {
    taskId: "task:test",
    goal: "test",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: []
  };
}
