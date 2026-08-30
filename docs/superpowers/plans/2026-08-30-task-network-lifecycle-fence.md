# Task Network Lifecycle Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a reopened Task epoch from starting until the previous epoch has finalized and released its Executor and Gateway resources.

**Architecture:** Add a Controller-owned Promise fence keyed by `taskId`. Terminal task handling registers cleanup synchronously before returning the Task execution, and sandbox preparation waits for the fence before beginning a new Gateway epoch. Existing Planner retry behavior and NetworkSandboxManager semantics remain unchanged.

**Tech Stack:** TypeScript, Node.js Promise lifecycle management, `node:test`

---

### Task 1: Reproduce the cross-epoch cleanup race

**Files:**
- Modify: `test/controller-connectivity-boundary.test.ts`

- [ ] **Step 1: Write the failing lifecycle-fence test**

Add a Controller harness with a deferred network finalization and a stubbed
`disposeTaskExecutorResources`. Schedule terminal cleanup for one epoch, then
wait for cleanup as a new epoch would. Assert that the wait remains pending
until finalization and cleanup both finish, and that cleanup runs exactly once.

```ts
test("reopened Task waits for prior epoch resource cleanup", async () => {
  const calls: string[] = [];
  const finalization = deferred<void>();
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  const harness = controller as unknown as LifecycleFenceHarness;
  harness.networkFinalizations = new Map([["epoch:old", finalization.promise]]);
  harness.taskExecutorResourceCleanups = new Map();
  harness.disposeTaskExecutorResources = async () => { calls.push("cleanup"); };

  harness.scheduleTaskExecutorResourceCleanup("task:recon", "epoch:old");
  let resumed = false;
  const waiting = harness.waitForTaskExecutorResourceCleanup("task:recon")
    .then(() => { resumed = true; calls.push("resume"); });

  await Promise.resolve();
  assert.equal(resumed, false);
  finalization.resolve();
  await waiting;
  assert.deepEqual(calls, ["cleanup", "resume"]);
});
```

- [ ] **Step 2: Write the cleanup-failure release test**

```ts
test("failed prior cleanup releases the Task lifecycle fence", async () => {
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  const harness = controller as unknown as LifecycleFenceHarness;
  harness.networkFinalizations = new Map();
  harness.taskExecutorResourceCleanups = new Map();
  harness.disposeTaskExecutorResources = async () => { throw new Error("cleanup failed"); };

  harness.scheduleTaskExecutorResourceCleanup("task:recon", "epoch:old");
  await harness.waitForTaskExecutorResourceCleanup("task:recon");
  assert.equal(harness.taskExecutorResourceCleanups.has("task:recon"), false);
});
```

- [ ] **Step 3: Build and run the focused test to verify RED**

Run:

```bash
npm run build:server
node --test --test-name-pattern='Task.*resource cleanup|lifecycle fence' dist/test/controller-connectivity-boundary.test.js
```

Expected: TypeScript compilation fails because the lifecycle-fence methods and
map do not exist, or the new behavior test fails for the same missing boundary.

### Task 2: Add the Controller lifecycle fence

**Files:**
- Modify: `src/controller.ts:432`
- Modify: `src/controller.ts:2519-2529`
- Modify: `src/controller.ts:2569-2578`
- Modify: `src/controller.ts:2899-2935`
- Test: `test/controller-connectivity-boundary.test.ts`

- [ ] **Step 1: Add the per-Task cleanup registry**

```ts
private taskExecutorResourceCleanups = new Map<string, Promise<void>>();
```

- [ ] **Step 2: Add scheduling and waiting helpers**

```ts
private scheduleTaskExecutorResourceCleanup(taskId: string, epochId: string): Promise<void> {
  const existing = this.taskExecutorResourceCleanups.get(taskId);
  if (existing) return existing;
  const finalization = this.networkFinalizations.get(epochId) ?? Promise.resolve();
  const cleanup = finalization
    .then(() => this.disposeTaskExecutorResources(taskId))
    .catch(() => undefined)
    .finally(() => {
      if (this.taskExecutorResourceCleanups.get(taskId) === cleanup) {
        this.taskExecutorResourceCleanups.delete(taskId);
      }
    });
  this.taskExecutorResourceCleanups.set(taskId, cleanup);
  return cleanup;
}

private async waitForTaskExecutorResourceCleanup(taskId: string): Promise<void> {
  await this.taskExecutorResourceCleanups.get(taskId);
}
```

- [ ] **Step 3: Register terminal cleanup before returning execution**

Replace the detached finalization chain with:

```ts
this.scheduleTaskExecutorResourceCleanup(taskEnvelope.taskId, state.epochId);
```

This call registers the Promise fence synchronously; it intentionally does not
await cleanup before returning the outcome to Planner.

- [ ] **Step 4: Wait at the new-epoch preparation boundary**

At the start of `prepareExecutorSandboxForEpoch`, after deriving `taskId` and
before `beginTaskEpoch`, add:

```ts
await this.waitForTaskExecutorResourceCleanup(taskId);
```

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```bash
npm run build:server
node --test dist/test/controller-connectivity-boundary.test.js
```

Expected: all Controller connectivity-boundary tests pass.

- [ ] **Step 6: Run broader Controller tests**

Run:

```bash
node --test --test-force-exit 'dist/test/controller-*.test.js'
```

Expected: all Controller tests pass with zero failures.

### Task 3: Verify and commit the fix

**Files:**
- Modify: `src/controller.ts`
- Modify: `test/controller-connectivity-boundary.test.ts`

- [ ] **Step 1: Run static and whitespace checks**

```bash
npm run build:server
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 2: Review the scoped diff**

```bash
git diff -- src/controller.ts test/controller-connectivity-boundary.test.ts
```

Expected: only the Task lifecycle fence, terminal cleanup registration, wait
boundary, and regression tests are present.

- [ ] **Step 3: Commit the implementation**

```bash
git add src/controller.ts test/controller-connectivity-boundary.test.ts docs/superpowers/plans/2026-08-30-task-network-lifecycle-fence.md
git commit -m "fix: serialize task network cleanup before retry"
```
