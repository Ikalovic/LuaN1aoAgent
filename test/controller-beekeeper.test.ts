import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { BeekeeperMcpRuntimeOptions } from "../src/mcp/beekeeper-runtime.js";
import type { TaskEnvelope } from "../src/types.js";

type FakeBeekeeperRuntime = {
  startCalls: number;
  closeCalls: number;
  start(): Promise<void>;
  call(): Promise<never>;
  close(): Promise<void>;
};

type ControllerBeekeeperHarness = {
  configureBeekeeperRuntime(): Promise<void>;
  createTaskRuntimeTools(task: TaskEnvelope): Array<{ name: string }>;
};

test("Controller starts Beekeeper MCP and injects unrestricted credential tools", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "controller-beekeeper-"));
  let options: BeekeeperMcpRuntimeOptions | undefined;
  const fake = fakeRuntime();
  const controller = createController(runtimeDir, {
    BEEKEEPER_MCP_ENABLED: "1",
    BEEKEEPER_ROOT: resolve("vendor/Beekeeper"),
    BEEKEEPER_MCP_PYTHON: resolve(".beekeeper-mcp-venv/bin/python")
  }, (input) => {
    options = input;
    return fake as never;
  });
  const harness = controller as unknown as ControllerBeekeeperHarness;

  assert.ok(harness.createTaskRuntimeTools(taskEnvelope()).every((tool) => !tool.name.includes("credential")));
  await harness.configureBeekeeperRuntime();
  assert.equal(fake.startCalls, 1);
  assert.equal(options?.config.root, resolve("vendor/Beekeeper"));
  assert.deepEqual(
    harness.createTaskRuntimeTools(taskEnvelope()).map((tool) => tool.name).filter((name) => name.includes("credential")).sort(),
    ["mark_credential_invalid", "query_credentials", "store_credential"]
  );
  const events = (await controller.executionLog.window({ limit: 20 })).events;
  assert.match(JSON.stringify(events), /beekeeper_mcp_ready/);
  await controller.close({ drainProjectionJobs: false });
  assert.equal(fake.closeCalls, 1);
});

test("Controller reports Beekeeper disabled or malformed without losing normal tools", async () => {
  for (const environment of [
    {},
    { BEEKEEPER_MCP_ENABLED: "1", BEEKEEPER_ROOT: "relative" }
  ]) {
    const runtimeDir = mkdtempSync(join(tmpdir(), "controller-beekeeper-disabled-"));
    let factoryCalls = 0;
    const controller = createController(runtimeDir, environment, () => {
      factoryCalls += 1;
      return fakeRuntime() as never;
    });
    const harness = controller as unknown as ControllerBeekeeperHarness;
    await harness.configureBeekeeperRuntime();
    const names = harness.createTaskRuntimeTools(taskEnvelope()).map((tool) => tool.name);
    assert.ok(names.includes("evidence_list"));
    assert.ok(names.every((name) => !name.includes("credential")));
    assert.equal(factoryCalls, 0);
    const events = (await controller.executionLog.window({ limit: 20 })).events;
    assert.match(JSON.stringify(events), /beekeeper_mcp_(disabled|failed)/);
    await controller.close({ drainProjectionJobs: false });
  }
});

test("Controller requestStop closes Beekeeper MCP", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "controller-beekeeper-stop-"));
  const fake = fakeRuntime();
  const controller = createController(runtimeDir, {
    BEEKEEPER_MCP_ENABLED: "1",
    BEEKEEPER_ROOT: resolve("vendor/Beekeeper"),
    BEEKEEPER_MCP_PYTHON: resolve(".beekeeper-mcp-venv/bin/python")
  }, () => fake as never);
  const harness = controller as unknown as ControllerBeekeeperHarness;
  await harness.configureBeekeeperRuntime();
  await controller.requestStop("operator stop");
  assert.equal(fake.closeCalls, 1);
  await controller.close({ drainProjectionJobs: false });
});

function createController(
  runtimeDir: string,
  environment: NodeJS.ProcessEnv,
  factory: (input: BeekeeperMcpRuntimeOptions) => never
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
      beekeeperRuntimeFactory: factory
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

function fakeRuntime(): FakeBeekeeperRuntime {
  return {
    startCalls: 0,
    closeCalls: 0,
    async start() { this.startCalls += 1; },
    async call() { throw new Error("not called"); },
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
