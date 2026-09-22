import assert from "node:assert/strict";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { ToolApprovalExtensionOptions } from "../src/approval/tool-approval-extension.js";

test("executor approval cancellation follows both the current epoch and the run", async () => {
  const controller = Object.create(SecurityAgentController.prototype);
  const run = new AbortController();
  let epoch = new AbortController();
  Object.assign(controller, {
    approvalMode: "auto", runId: "run:1", runtimeDir: "run-a", activeScopeSummary: "authorized",
    invocationAbortController: run,
    getActiveTaskState: () => ({ invocationAbortController: epoch })
  });
  const options: ToolApprovalExtensionOptions = await controller.executorToolApproval({ taskId: "task:1", goal: "test" });
  assert.equal(typeof options.signal, "function");
  const currentSignal = options.signal as () => AbortSignal;
  const first = currentSignal();
  epoch.abort();
  assert.equal(first.aborted, true);
  epoch = new AbortController();
  const second = currentSignal();
  assert.equal(second.aborted, false);
  run.abort();
  assert.equal(second.aborted, true);
});
