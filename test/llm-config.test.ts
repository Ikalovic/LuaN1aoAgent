import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createAgentSession,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import {
  createLlmRuntime,
  loadLlmRuntimeConfig,
  normalizeOpenAIBaseUrl,
  normalizeOpenAICompletionsBaseUrl,
  providerAdmissionKey
} from "../src/llm-config.js";

test("normalizes full chat completions endpoint to OpenAI-compatible base URL", () => {
  assert.equal(
    normalizeOpenAICompletionsBaseUrl("https://example.test/api/openai/chat/completions"),
    "https://example.test/api/openai"
  );
});

test("registers LLM runtime from LLM_* environment", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai/chat/completions",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "feature/deepseek"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.model.provider, "baizhi-openai");
  assert.equal(runtime.model.id, "feature/deepseek");
  assert.equal(runtime.model.baseUrl, "https://example.test/api/openai");
  assert.equal(runtime.model.api, "openai-completions");
  assert.deepEqual(runtime.metadata.costPerMillionTokens, {
    input: 3,
    output: 6,
    cacheRead: 0.025,
    cacheWrite: 0
  });
  assert.equal(runtime.metadata.costCurrency, "CNY");
  assert.equal("apiKey" in runtime.metadata, false);
});

test("registers OpenAI Responses runtime when LLM_API_TYPE requests it", () => {
  assert.equal(
    normalizeOpenAIBaseUrl("https://example.test/api/openai/responses", "openai-responses"),
    "https://example.test/api/openai"
  );
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "sec/gpt-5.5",
    LLM_API_TYPE: "openai-responses"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(config.apiType, "openai-responses");
  assert.equal(runtime.model.api, "openai-responses");
  assert.equal(runtime.model.baseUrl, "https://example.test/api/openai");
});

test("defaults to Chat Completions when LLM_API_TYPE is omitted", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai/responses",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "sec/gpt-5.5"
  });
  assert.equal(config.apiType, "openai-completions");
});

test("uses bounded role completion defaults when no global budget override is configured", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2"
  });
  assert.equal(config.defaultMaxTokens, 32_768);
  assert.equal(config.thinkingFormat, "zai");
  const expected = { planner: 16_384, executor: 16_384, supervisor: 4_096, projector: 16_384 };
  for (const role of ["planner", "executor", "supervisor", "projector"] as const) {
    assert.equal(config.roles[role].modelId, "glm-5.2");
    assert.equal(config.roles[role].maxTokens, expected[role]);
    assert.equal(config.roles[role].thinkingLevel, "off");
  }
  const runtime = createLlmRuntime(config);
  for (const role of ["planner", "executor", "supervisor", "projector"] as const) {
    assert.equal(runtime.models[role].provider, "baizhi-openai");
    assert.equal(runtime.models[role].id, "glm-5.2");
    assert.equal(runtime.metadata.models[role].modelId, "glm-5.2");
    assert.equal(runtime.models[role].maxTokens, expected[role]);
  }
  assert.equal(runtime.model, runtime.models.planner);
});

test("registers per-role models, budgets and thinking levels from LLM_<ROLE>_* overrides", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_MAX_TOKENS: "16384",
    LLM_EXECUTOR_MODEL: "deepseek-v4-pro-202606",
    LLM_PLANNER_MAX_TOKENS: "65536",
    LLM_PLANNER_THINKING: "low",
    LLM_SUPERVISOR_MODEL: "glm-5.2"
  });
  assert.equal(config.roles.executor.modelId, "deepseek-v4-pro-202606");
  assert.equal(config.roles.executor.maxTokens, 16_384);
  assert.equal(config.roles.planner.maxTokens, 65_536);
  assert.equal(config.roles.planner.thinkingLevel, "low");
  assert.equal(config.roles.projector.modelId, "glm-5.2");
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.models.executor.id, "deepseek-v4-pro-202606");
  assert.equal(runtime.models.planner.maxTokens, 65_536);
  assert.equal(runtime.models.supervisor.maxTokens, 16_384);
  // planner/supervisor/projector share the default model id in one provider;
  // the executor variant gets its own registration.
  assert.equal(runtime.models.planner.provider, "baizhi-openai");
  assert.equal(runtime.models.executor.provider, "baizhi-openai");
  assert.equal(runtime.metadata.models.executor.modelId, "deepseek-v4-pro-202606");
});

test("registers a dedicated provider for roles with their own base URL or API key", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_EXECUTOR_BASE_URL: "https://backup.test/v1/chat/completions",
    LLM_EXECUTOR_API_KEY: "backup-key",
    LLM_EXECUTOR_MODEL: "glm-5.2"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.models.executor.provider, "baizhi-openai-executor");
  assert.equal(runtime.models.executor.baseUrl, "https://backup.test/v1");
  assert.equal(runtime.models.planner.provider, "baizhi-openai");
  assert.equal(runtime.models.planner.baseUrl, "https://example.test/api/openai");
  assert.equal("backup-key" in runtime.metadata.models.executor, false);
  assert.equal(providerAdmissionKey(runtime, "planner"), providerAdmissionKey(runtime, "projector"));
  assert.notEqual(providerAdmissionKey(runtime, "planner"), providerAdmissionKey(runtime, "executor"));
  assert.doesNotMatch(providerAdmissionKey(runtime, "executor"), /backup-key/);
});

test("keeps per-role budgets distinct when roles share a model id", () => {
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_PLANNER_MAX_TOKENS: "65536"
  });
  const runtime = createLlmRuntime(config);
  assert.equal(runtime.models.planner.maxTokens, 65_536);
  assert.equal(runtime.models.executor.maxTokens, 16_384);
  assert.equal(runtime.models.planner.id, "glm-5.2");
  assert.equal(runtime.models.executor.id, "glm-5.2");
  assert.notEqual(runtime.models.planner, runtime.models.executor);
});

test("sends the real model id and the supervisor-local completion cap on the wire", async () => {
  let resolveRequest: (payload: Record<string, unknown>) => void = () => undefined;
  const requestPayload = new Promise<Record<string, unknown>>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"glm-5.2\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n");
      response.write("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"glm-5.2\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const config = loadLlmRuntimeConfig({
    LLM_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2"
  });
  const runtime = createLlmRuntime(config);
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    noTools: "all",
    authStorage: runtime.authStorage,
    modelRegistry: runtime.modelRegistry,
    model: runtime.models.supervisor,
    thinkingLevel: runtime.roleConfig.supervisor.thinkingLevel,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(process.cwd())
  });
  try {
    await session.prompt("reply ok");
    const payload = await requestPayload;
    assert.equal(payload.model, "glm-5.2");
    assert.equal(payload.max_completion_tokens, 4_096);
  } finally {
    session.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects unsupported thinking level and format values", () => {
  assert.throws(() => loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_PLANNER_THINKING: "ultra"
  }), /Unsupported thinking level/);
  assert.throws(() => loadLlmRuntimeConfig({
    LLM_API_BASE_URL: "https://example.test/api/openai",
    LLM_API_KEY: "test-key",
    LLM_DEFAULT_MODEL: "glm-5.2",
    LLM_THINKING_FORMAT: "xml"
  }), /Unsupported LLM_THINKING_FORMAT/);
});
