import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attachExecutionLogging,
  classifyLlmErrorKind,
  createProviderAdmissionExtension,
  invokeStructured,
  ProviderAdmissionCancelledError,
  ProviderAdmissionGate,
  promptAndCollect,
  PromptRuntimeError,
  StructuredInvocationError
} from "../src/pi-runner.js";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { ExecutionLog } from "../src/stores/execution-log.js";

test("collects final message text when text deltas are absent", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            content: [
              { type: "thinking", thinking: "ignored" },
              { type: "text", text: "{\"ok\":true}" }
            ],
            role: "assistant"
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  assert.equal(await promptAndCollect(session, "test"), "{\"ok\":true}");
});

test("ignores user and toolResult message echoes when collecting final output", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: "USER_GOAL:\n{\"view\":\"planner_decision\"}" }]
          }
        });
        listener({
          type: "message_end",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "{\"not\":\"assistant\"}" }]
          }
        });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "{\"decision\":\"apply_commands\"}" }]
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  assert.equal(await promptAndCollect(session, "test"), "{\"decision\":\"apply_commands\"}");
});

test("fails clearly when Pi session emits no assistant output", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: "USER_GOAL:\n..." }]
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  await assert.rejects(
    () => promptAndCollect(session, "test"),
    /No assistant output collected from Pi session/
  );
});

test("collects terminating tool details without assistant text", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName: "task_result_submit",
          isError: false,
          result: { details: { status: "completed", summary: "done" } }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", { toolName: "task_result_submit" }), {
    status: "completed",
    summary: "done"
  });
});

test("clears queued Pi messages before completing a terminating tool submission", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let queued = true;
  let secondSubmitCount = 0;
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "task_result_submit",
        isError: false,
        result: { details: { status: "partial", summary: "checkpoint" } }
      });
      await delay(5);
      if (queued) {
        secondSubmitCount += 1;
        emitToListeners(listeners, {
          type: "tool_execution_end",
          toolName: "task_result_submit",
          isError: false,
          result: { details: { status: "completed", summary: "stale queued continuation" } }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    clearQueue(): void {
      queued = false;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", { toolName: "task_result_submit" }), {
    status: "partial",
    summary: "checkpoint"
  });
  assert.equal(secondSubmitCount, 0);
});

test("fails with a protocol error when terminal submit is missing", async () => {
  const session = {
    async prompt(): Promise<void> {},
    subscribe(): () => void {
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", { toolName: "planner_submit" }),
    /completed without planner_submit/
  );
});

test("steers the session into submitting when the response is truncated at the token limit", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  const session = {
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      if (prompts.length === 1) {
        emitToListeners(listeners, {
          type: "message_end",
          message: { role: "assistant", stopReason: "length", content: [] }
        });
        return;
      }
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse", content: [] }
      });
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: false,
        result: { details: { decision: "apply_commands", reason: "submitted after steer" } }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), { decision: "apply_commands", reason: "submitted after steer" });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /截断/);
  assert.match(prompts[1] ?? "", /planner_submit/);
});

test("reports missing_submit after truncation steers are exhausted", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let promptCount = 0;
  const session = {
    async prompt(): Promise<void> {
      promptCount += 1;
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "length", content: [] }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "planner_submit",
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 5_000,
      maxTruncationSteers: 2
    }),
    (error) => error instanceof StructuredInvocationError && error.code === "missing_submit"
  );
  assert.equal(promptCount, 3);
});

test("does not steer when the truncated turn ends with a provider error", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let promptCount = 0;
  const session = {
    async prompt(): Promise<void> {
      promptCount += 1;
      emitToListeners(listeners, {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "length",
          errorMessage: "HTTP 503 service unavailable",
          content: []
        }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "planner_submit",
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 2_000
    }),
    (error) => error instanceof StructuredInvocationError && error.code === "provider_error"
  );
  assert.equal(promptCount, 1);
});

test("lets Pi finish its native provider retry lifecycle before rejecting", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let abortCount = 0;
  let promptSettled = false;
  const session = {
    async prompt(): Promise<void> {
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: { role: "assistant", errorMessage: "terminated", content: [] }
        });
        listener({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1,
          errorMessage: "terminated"
        });
      }
      await delay(10);
      for (const listener of [...listeners]) {
        listener({ type: "auto_retry_end", success: false, attempt: 1, finalError: "terminated" });
      }
      promptSettled = true;
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {
      abortCount += 1;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "planner_submit",
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 2_000
    }),
    /terminated/
  );
  assert.equal(promptSettled, true);
  assert.equal(abortCount, 0);
});

test("accepts a terminal submit after Pi recovers through native provider retry", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  let promptCount = 0;
  const session = {
    async prompt(): Promise<void> {
      promptCount += 1;
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 service unavailable", content: [] }
      });
      emitToListeners(listeners, {
        type: "agent_end",
        messages: [],
        willRetry: true
      });
      emitToListeners(listeners, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        errorMessage: "HTTP 503 service unavailable"
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "toolUse", content: [] }
      });
      emitToListeners(listeners, { type: "auto_retry_end", success: true, attempt: 1 });
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: false,
        result: { details: { decision: "apply_commands", reason: "recovered" } }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000,
    admission: { key: "provider:test", gate }
  }), { decision: "apply_commands", reason: "recovered" });
  assert.equal(promptCount, 1);
});

test("admits provider requests in FIFO order at the configured concurrency limit", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const first = await gate.acquire({ key: "provider:a" });
  const admitted: string[] = [];
  const secondPromise = gate.acquire({ key: "provider:a" }).then((lease) => {
    admitted.push("second");
    return lease;
  });
  const thirdPromise = gate.acquire({ key: "provider:a" }).then((lease) => {
    admitted.push("third");
    return lease;
  });

  await flushMicrotasks();
  assert.deepEqual(admitted, []);
  first.release();
  const second = await secondPromise;
  assert.deepEqual(admitted, ["second"]);
  second.release();
  const third = await thirdPromise;
  assert.deepEqual(admitted, ["second", "third"]);
  third.release();
});

test("isolates admission limits by provider key", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const firstProviderLease = await gate.acquire({ key: "provider:a" });
  let secondProviderAAdmitted = false;
  const secondProviderAPromise = gate.acquire({ key: "provider:a" }).then((lease) => {
    secondProviderAAdmitted = true;
    return lease;
  });

  const providerBLease = await gate.acquire({ key: "provider:b" });
  assert.equal(secondProviderAAdmitted, false);
  providerBLease.release();
  firstProviderLease.release();
  const secondProviderALease = await secondProviderAPromise;
  secondProviderALease.release();
});

test("releases provider admission before tool execution begins", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const extension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  await extension.emit("before_provider_request");
  let competingRequestAdmitted = false;
  const competingRequest = gate.acquire({ key: "provider:a" }).then((lease) => {
    competingRequestAdmitted = true;
    return lease;
  });

  await flushMicrotasks();
  assert.equal(competingRequestAdmitted, false);
  await extension.emit("message_end", {
    message: { role: "assistant", content: [] }
  });
  await extension.emit("tool_execution_start", { toolName: "bash" });
  await flushMicrotasks();
  assert.equal(competingRequestAdmitted, true);
  const competingLease = await competingRequest;
  competingLease.release();
});

test("cancels a queued request-level admission without disturbing the active request", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const activeExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  await activeExtension.emit("before_provider_request");
  const abortController = new AbortController();
  const queuedExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  const queued = queuedExtension.emit("before_provider_request", {}, abortController.signal);

  abortController.abort();
  await assert.rejects(
    queued,
    (error) => error instanceof ProviderAdmissionCancelledError
  );
  assert.equal(queuedExtension.abortCount(), 1);
  await activeExtension.emit("message_end", {
    message: { role: "assistant", content: [] }
  });
  const nextLease = await gate.acquire({ key: "provider:a" });
  nextLease.release();
});

test("admits request extensions in FIFO order", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const firstExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  const secondExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  const thirdExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  const admitted: string[] = [];

  await firstExtension.emit("before_provider_request");
  const secondRequest = secondExtension.emit("before_provider_request").then(() => admitted.push("second"));
  const thirdRequest = thirdExtension.emit("before_provider_request").then(() => admitted.push("third"));
  await flushMicrotasks();
  assert.deepEqual(admitted, []);

  await firstExtension.emit("message_end", { message: { role: "assistant", content: [] } });
  await secondRequest;
  assert.deepEqual(admitted, ["second"]);
  await secondExtension.emit("agent_end");
  await thirdRequest;
  assert.deepEqual(admitted, ["second", "third"]);
  await thirdExtension.emit("session_shutdown");
});

test("does not infer admission for an unkeyed session", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const activeLease = await gate.acquire({ key: "provider:a" });
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    model: { provider: "provider:a" },
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ungated" }] }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.equal(await promptAndCollect(session, "unkeyed"), "ungated");
  activeLease.release();
});

test("prompt-level admission observes cooldown without acquiring a provider lease", async () => {
  const gate = new ProviderAdmissionGate({ defaultMaxConcurrent: 1 });
  const activeLease = await gate.acquire({ key: "provider:a" });
  const listeners: Array<(event: unknown) => void> = [];
  let promptCount = 0;
  const session = {
    async prompt(): Promise<void> {
      promptCount += 1;
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "observed" }] }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.equal(await promptAndCollect(session, "observe", {
    admission: { key: "provider:a", gate }
  }), "observed");
  assert.equal(promptCount, 1);
  activeLease.release();
});

test("honors Retry-After cooldown before admitting the next provider request", async () => {
  const clock = createManualClock();
  const gate = new ProviderAdmissionGate({
    defaultMaxConcurrent: 1,
    now: clock.now,
    sleep: clock.sleep
  });
  const activeLease = await gate.acquire({ key: "provider:a" });
  gate.observe("provider:a", {
    type: "message_end",
    headers: { "retry-after": "5" }
  });
  activeLease.release();
  let admitted = false;
  const queuedPromise = gate.acquire({ key: "provider:a" }).then((lease) => {
    admitted = true;
    return lease;
  });

  clock.advance(4_999);
  await flushMicrotasks();
  assert.equal(admitted, false);
  clock.advance(1);
  await flushMicrotasks();
  assert.equal(admitted, true);
  const queuedLease = await queuedPromise;
  queuedLease.release();
});

test("applies after_provider_response Retry-After headers to request admission", async () => {
  const clock = createManualClock();
  const gate = new ProviderAdmissionGate({
    defaultMaxConcurrent: 1,
    now: clock.now,
    sleep: clock.sleep
  });
  const firstExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  const secondExtension = await createProviderAdmissionHarness({ key: "provider:a", gate });
  await firstExtension.emit("before_provider_request");
  await firstExtension.emit("after_provider_response", {
    status: 429,
    headers: { "retry-after": "5" }
  });
  await firstExtension.emit("message_end", { message: { role: "assistant", content: [] } });

  let secondAdmitted = false;
  const secondRequest = secondExtension.emit("before_provider_request").then(() => {
    secondAdmitted = true;
  });
  clock.advance(4_999);
  await flushMicrotasks();
  assert.equal(secondAdmitted, false);
  clock.advance(1);
  await secondRequest;
  assert.equal(secondAdmitted, true);
  await secondExtension.emit("agent_end");
});

test("uses Pi native retry delay as provider cooldown without retrying prompts itself", async () => {
  const clock = createManualClock();
  const gate = new ProviderAdmissionGate({
    defaultMaxConcurrent: 1,
    now: clock.now,
    sleep: clock.sleep
  });
  const listeners: Array<(event: unknown) => void> = [];
  let firstPromptCount = 0;
  let finishFirstPrompt: (() => void) | undefined;
  const firstSession = {
    async prompt(): Promise<void> {
      firstPromptCount += 1;
      emitToListeners(listeners, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: "HTTP 429 too many requests"
      });
      await new Promise<void>((resolve) => {
        finishFirstPrompt = resolve;
      });
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "recovered" }] }
      });
      emitToListeners(listeners, { type: "auto_retry_end", success: true, attempt: 1 });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };
  const firstInvocation = promptAndCollect(firstSession, "first", {
    admission: { key: "provider:a", gate }
  });
  await waitForValue(() => finishFirstPrompt !== undefined);
  let secondAdmitted = false;
  const secondLeasePromise = gate.acquire({ key: "provider:a" }).then((lease) => {
    secondAdmitted = true;
    return lease;
  });

  finishFirstPrompt?.();
  assert.equal(await firstInvocation, "recovered");
  assert.equal(firstPromptCount, 1);
  await flushMicrotasks();
  assert.equal(secondAdmitted, false);
  clock.advance(2_000);
  await flushMicrotasks();
  assert.equal(secondAdmitted, true);
  const secondLease = await secondLeasePromise;
  secondLease.release();
});

test("admits one request at a time after rate limiting until one provider response succeeds", async () => {
  const clock = createManualClock();
  const gate = new ProviderAdmissionGate({
    defaultMaxConcurrent: 3,
    now: clock.now,
    sleep: clock.sleep
  });
  const active = await Promise.all([
    gate.acquire({ key: "provider:a" }),
    gate.acquire({ key: "provider:a" }),
    gate.acquire({ key: "provider:a" })
  ]);
  gate.observe("provider:a", {
    type: "auto_retry_start",
    delayMs: 2_000,
    errorMessage: "HTTP 429 TPM limit exceeded"
  });
  const admitted: string[] = [];
  const queued = ["first", "second", "third"].map((name) => gate.acquire({ key: "provider:a" }).then((lease) => {
    admitted.push(name);
    return lease;
  }));
  active.forEach((lease) => lease.release());

  clock.advance(2_000);
  await flushMicrotasks();
  assert.deepEqual(admitted, ["first"]);
  const first = await queued[0];
  first.release();
  await flushMicrotasks();
  assert.deepEqual(admitted, ["first", "second"]);

  gate.observe("provider:a", { type: "after_provider_response", status: 200 });
  await flushMicrotasks();
  assert.deepEqual(admitted, ["first", "second", "third"]);
  const second = await queued[1];
  const third = await queued[2];
  second.release();
  third.release();
});

test("lets the same Pi session repair a terminal submit validation error", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let promptCount = 0;
  const session = {
    async prompt(): Promise<void> {
      promptCount += 1;
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: true,
        result: {
          content: [{
            type: "text",
            text: {
              artifactRef: "artifact:validation-error",
              preview: "Validation failed for tool planner_submit: reason is required"
            }
          }]
        }
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: false,
        result: {
          details: {
            decision: "apply_commands",
            commands: [],
            reason: "Repair the malformed submission",
            basedOnRefs: ["goal:root"]
          }
        }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), {
    decision: "apply_commands",
    commands: [],
    reason: "Repair the malformed submission",
    basedOnRefs: ["goal:root"]
  });
  assert.equal(promptCount, 1);
});

test("terminates a projector invocation on the first rejected graph draft", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let aborted = false;
  let staleRepairSubmitted = false;
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "graph_delta_submit",
        isError: true,
        result: { content: [{ type: "text", text: "Projection delta is invalid" }] }
      });
      await delay(5);
      if (!aborted) {
        staleRepairSubmitted = true;
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {
      aborted = true;
    },
    clearQueue(): void {
      aborted = true;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "graph_delta_submit",
      terminateOnToolError: true
    }),
    (error) => error instanceof StructuredInvocationError
      && error.code === "invalid_submit"
      && error.message === "Projection delta is invalid"
  );
  assert.equal(aborted, true);
  assert.equal(staleRepairSubmitted, false);
});

test("lets Projector repair one rejected graph draft in the same session", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "graph_delta_submit",
        isError: true,
        result: { content: [{ type: "text", text: "Unknown alias new:9" }] }
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "graph_delta_submit",
        isError: false,
        result: { details: { nodes: [], edges: [] } }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {}
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "graph_delta_submit",
    maxRepeatedToolErrors: 2,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), { nodes: [], edges: [] });
});

test("stops Projector after the same rejected graph draft is submitted twice", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let aborted = false;
  const session = {
    async prompt(): Promise<void> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        emitToListeners(listeners, {
          type: "tool_execution_start",
          toolName: "graph_delta_submit",
          toolCallId: `call:${attempt}`,
          args: { nodes: [{ id: "new:9" }], edges: [] }
        });
        emitToListeners(listeners, {
          type: "tool_execution_end",
          toolName: "graph_delta_submit",
          toolCallId: `call:${attempt}`,
          isError: true,
          result: { content: [{ type: "text", text: "Unknown alias new:9" }] }
        });
        await delay(1);
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {
      aborted = true;
    },
    clearQueue(): void {
      aborted = true;
    }
  };

  await assert.rejects(() => invokeStructured(session, "test", {
    toolName: "graph_delta_submit",
    maxRepeatedToolErrors: 2,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), (error) => error instanceof StructuredInvocationError
    && error.code === "invalid_submit"
    && error.message === "Unknown alias new:9");
  assert.equal(aborted, true);
});

test("does not treat a changed Projector draft as the same rejected submission", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const [attempt, label] of ["first", "second"].entries()) {
        emitToListeners(listeners, {
          type: "tool_execution_start",
          toolName: "graph_delta_submit",
          toolCallId: `call:${attempt}`,
          args: { nodes: [{ id: "new:9", label }], edges: [] }
        });
        emitToListeners(listeners, {
          type: "tool_execution_end",
          toolName: "graph_delta_submit",
          toolCallId: `call:${attempt}`,
          isError: true,
          result: { content: [{ type: "text", text: "Unknown alias new:9" }] }
        });
        await delay(1);
      }
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "graph_delta_submit",
        isError: false,
        result: { details: { nodes: [], edges: [] } }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {}
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "graph_delta_submit",
    maxRepeatedToolErrors: 2,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 2_000
  }), { nodes: [], edges: [] });
});

test("preserves terminal validation details when the session does not repair the submit", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: true,
        result: {
          content: [{ type: "text", text: "Validation failed: reason is required" }]
        }
      });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", { toolName: "planner_submit" }),
    (error) => error instanceof StructuredInvocationError
      && error.code === "invalid_submit"
      && error.message === "Validation failed: reason is required"
  );
});

test("does not misclassify a missing terminal submit after successful native retry", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 service unavailable", content: [] }
      });
      emitToListeners(listeners, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        errorMessage: "HTTP 503 service unavailable"
      });
      await delay(5);
      emitToListeners(listeners, {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }
      });
      emitToListeners(listeners, { type: "auto_retry_end", success: true, attempt: 1 });
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    }
  };

  await assert.rejects(
    () => invokeStructured(session, "test", {
      toolName: "planner_submit",
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 2_000
    }),
    (error) => error instanceof Error
      && error.message.includes("completed without planner_submit")
      && !(error instanceof PromptRuntimeError)
  );
});

test("resets structured invocation idle timeout on meaningful Pi progress", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      await delay(15);
      for (const listener of [...listeners]) {
        listener({ type: "tool_execution_start", toolName: "graph_query" });
      }
      await delay(20);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName: "planner_submit",
          isError: false,
          result: { details: { decision: "apply_commands" } }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    async abort(): Promise<void> {}
  };

  assert.deepEqual(await invokeStructured(session, "test", {
    toolName: "planner_submit",
    idleTimeoutMs: 25,
    hardTimeoutMs: 100
  }), { decision: "apply_commands" });
});

test("keeps small tool output inline in execution log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  attachExecutionLogging({
    session,
    executionLog,
    artifactStore,
    role: "executor",
    getTaskId: () => "task:small"
  });

  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: "small output" }]
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(((event.payload.result as { content: Array<{ text: string }> }).content[0]).text, "small output");
  assert.deepEqual(await artifactStore.list({ taskId: "task:small" }), []);
});

test("records graph tool acceptance as a draft pending GraphStore commit", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "observer",
    getTaskId: () => "task:projection-draft"
  });

  session.emit({
    type: "tool_execution_end",
    toolName: "graph_delta_submit",
    isError: false,
    result: { details: { nodes: [], edges: [] } }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(event.eventType, "projection_draft_received");
  assert.equal(event.summary, "projection_draft_received:accepted_pending_commit");
  assert.notEqual(event.eventType, "projection_job_succeeded");
});

test("SDK compaction events are not persisted as tool events or observations", async () => {
  // Auto-compaction only rewrites the session's internal context; the raw
  // observation stream (what the Projector consumes) must stay untouched and
  // these session-lifecycle events must not be mistaken for tool activity.
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:ctxmgr",
    getEpochId: () => "epoch:ctxmgr-1"
  });

  session.emit({ type: "compaction_start", reason: "threshold" });
  session.emit({ type: "compaction_end", reason: "threshold", result: { ok: true }, aborted: false, willRetry: false });
  // A known persisted event afterwards proves the subscription kept working.
  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "call:after-ctx-reset",
    result: {
      content: [{ type: "text", text: "still logging" }]
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const events = await executionLog.readAll();
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "tool_finished");
  assert.ok(!JSON.stringify(events).includes("compaction"));
});

test("spills large tool output to artifact and leaves pointer in execution log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  attachExecutionLogging({
    session,
    executionLog,
    artifactStore,
    role: "executor",
    getTaskId: () => "task:large",
    spillThreshold: 20
  });
  const largeOutput = "x".repeat(64);

  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: largeOutput }]
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  const pointer = ((event.payload.result as { content: Array<{ text: Record<string, unknown> }> }).content[0]).text;
  assert.equal(pointer.truncated, true);
  assert.equal(pointer.byteLength, 64);
  assert.equal(event.artifactRefs?.length, 1);
  assert.equal(await artifactStore.read(pointer.artifactRef as string), largeOutput);
});

test("preserves public intent text and tool call id in assistant intent events", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const logging = attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:recon"
  });

  session.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "读取 Web CTF 技能指南，确认当前侦查任务适用的验证方法。" },
        {
          type: "toolCall",
          id: "call:read-skill",
          name: "read",
          arguments: { path: "/skills/ctf-web/SKILL.md", limit: 80 }
        }
      ]
    }
  });
  session.emit({
    type: "tool_execution_start",
    toolCallId: "call:read-skill",
    toolName: "read",
    args: { path: "/skills/ctf-web/SKILL.md", limit: 80 }
  });
  session.emit({
    type: "tool_execution_end",
    toolCallId: "call:read-skill",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "skill content" }] }
  });
  await logging.drain();

  const events = await executionLog.readAll();
  assert.deepEqual(events.map((event) => event.eventType), ["assistant_intent", "tool_started", "tool_finished"]);
  assert.equal(events[0]?.payload.text, "读取 Web CTF 技能指南，确认当前侦查任务适用的验证方法。");
  assert.deepEqual(events[0]?.payload.toolCalls, [{
    id: "call:read-skill",
    name: "read",
    arguments: { path: "/skills/ctf-web/SKILL.md", limit: 80 }
  }]);
  assert.equal(events[1]?.payload.toolCallId, "call:read-skill");
  assert.equal(events[2]?.payload.toolCallId, "call:read-skill");
});

test("preserves Pi event order while large outputs spill asynchronously", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const logging = attachExecutionLogging({
    session,
    executionLog,
    artifactStore,
    role: "executor",
    getTaskId: () => "task:ordered",
    spillThreshold: 20
  });

  session.emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: { content: [{ type: "text", text: "x".repeat(1000) }] }
  });
  session.emit({
    type: "turn_end",
    message: {
      role: "assistant",
      provider: "test-provider",
      model: "test-model",
      responseId: "response:1",
      api: "openai-completions",
      stopReason: "toolUse",
      usage: {
        input: 7,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0.000021, output: 0.000018, cacheRead: 0.00000005, cacheWrite: 0, total: 0.00003905 }
      }
    }
  });
  await logging.drain();

  const events = await executionLog.readAll();
  assert.deepEqual(events.map((event) => event.eventType), ["tool_finished", "turn_usage"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(events[1]?.payload.usage, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0.000021, output: 0.000018, cacheRead: 0.00000005, cacheWrite: 0, total: 0.00003905 }
  });
  assert.equal(events[1]?.payload.responseId, "response:1");
});

test("annotates budget abort separately from llm errors", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:budget",
    getAbortContext: () => ({
      kind: "budget_abort",
      reason: "Task budget reached: maxTurns=1"
    })
  });

  session.emit({
    type: "message_end",
    message: {
      stopReason: "aborted",
      errorMessage: "Request was aborted.",
      content: []
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  const runtimeAbort = event.payload.runtimeAbort as Record<string, unknown>;
  assert.equal(event.eventType, "runtime_control");
  assert.equal(event.summary, "runtime_abort:budget_abort");
  assert.equal(event.payload.errorKind, "budget_abort");
  assert.equal(runtimeAbort.expected, true);
  assert.equal(runtimeAbort.kind, "budget_abort");
  assert.equal(runtimeAbort.reason, "Task budget reached: maxTurns=1");
});

test("classifies unhandled Pi error events as llm errors", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:error"
  });

  session.emit({
    type: "message_end",
    message: {
      stopReason: "error",
      errorMessage: "upstream model request failed",
      content: []
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(event.eventType, "provider_error");
  assert.equal(event.summary, "provider_error:llm_error");
  assert.equal(event.payload.errorKind, "llm_error");
});

test("classifies provider concurrency errors as retryable prompt runtime errors", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    async prompt(): Promise<void> {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            stopReason: "error",
            errorMessage: "Concurrency limit exceeded for user, please retry later",
            content: []
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };

  await assert.rejects(
    () => promptAndCollect(session, "test"),
    (error) => error instanceof PromptRuntimeError && error.errorKind === "provider_concurrency"
  );
  assert.equal(classifyLlmErrorKind("HTTP 429 too many requests"), "provider_rate_limit");
});

test("annotates provider concurrency events in execution log", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "executor",
    getTaskId: () => "task:provider"
  });

  session.emit({
    type: "message_end",
    message: {
      stopReason: "error",
      errorMessage: "Concurrency limit exceeded for user, please retry later",
      content: []
    }
  });

  await waitFor(async () => (await executionLog.readAll()).length === 1);
  const [event] = await executionLog.readAll();
  assert.equal(event.eventType, "provider_error");
  assert.equal(event.summary, "provider_error:provider_concurrency");
  assert.equal(event.payload.errorKind, "provider_concurrency");
  assert.deepEqual(event.payload.llmError, {
    retryable: true,
    message: "Concurrency limit exceeded for user, please retry later"
  });
});

test("records Pi native provider retry lifecycle events", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-runner-"));
  const session = createMockSession();
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  attachExecutionLogging({
    session,
    executionLog,
    role: "planner"
  });

  session.emit({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "terminated"
  });
  session.emit({
    type: "auto_retry_end",
    success: true,
    attempt: 1
  });

  await waitFor(async () => (await executionLog.readAll()).length === 2);
  const events = await executionLog.readAll();
  assert.deepEqual(events.map((event) => event.eventType), [
    "provider_retry_started",
    "provider_retry_completed"
  ]);
  assert.equal(events[1]?.payload.success, true);
});

function createMockSession(): {
  emit: (event: unknown) => void;
  prompt: () => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
} {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    emit(event: unknown): void {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    async prompt(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    }
  };
}

function emitToListeners(listeners: Array<(event: unknown) => void>, event: unknown): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

async function createProviderAdmissionHarness(
  input: Parameters<typeof createProviderAdmissionExtension>[0]
): Promise<{
  emit(type: string, event?: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  abortCount(): number;
}> {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const extension = createProviderAdmissionExtension(input);
  let aborts = 0;
  await extension({
    on(event: string, handler: (event: unknown, context: unknown) => unknown): void {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    }
  } as never);
  return {
    async emit(type, event = {}, signal): Promise<void> {
      for (const handler of handlers.get(type) ?? []) {
        await handler({ type, ...event }, {
          signal,
          abort: () => {
            aborts += 1;
          }
        });
      }
    },
    abortCount: () => aborts
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForValue(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for value");
    }
    await delay(1);
  }
}

function createManualClock(): {
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
  advance: (delayMs: number) => void;
} {
  let currentTime = 0;
  const sleepers: Array<{ wakeAt: number; resolve: () => void }> = [];
  return {
    now: () => currentTime,
    sleep: (delayMs) => new Promise<void>((resolve) => {
      sleepers.push({ wakeAt: currentTime + delayMs, resolve });
    }),
    advance: (delayMs) => {
      currentTime += delayMs;
      for (let index = sleepers.length - 1; index >= 0; index -= 1) {
        const sleeper = sleepers[index];
        if (sleeper && sleeper.wakeAt <= currentTime) {
          sleepers.splice(index, 1);
          sleeper.resolve();
        }
      }
    }
  };
}
