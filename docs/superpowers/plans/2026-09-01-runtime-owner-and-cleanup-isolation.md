# Runtime Owner and Docker Cleanup Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent local LuaN1ao Runtime processes and test Web servers from misclassifying a live owner as stale and deleting that owner's Docker Gateway, Executor, connector, and task-network resources.

**Architecture:** Make process-start identity deterministic across process boundaries by deriving it from the operating system for both the owner and observers. Keep the existing heartbeat/PID fallback when the OS identity cannot be read. Restrict startup orphan cleanup to the explicitly selected runtime directory so a process using a temporary runtime cannot scan or clean the project's active `.agent-runtime` tree.

**Tech Stack:** TypeScript, Node.js 22, `node:test`, Docker CLI abstraction, Linux `/proc` process metadata

---

## Task 1: Reproduce cross-process owner misclassification

**Files:**
- Modify: `test/mitm-flow-client.test.ts`
- Test: `test/mitm-flow-client.test.ts`

- [ ] **Step 1: Add child-process test helpers**

Import `execFile` from `node:child_process` and `promisify` from `node:util`, then create a local promisified helper. The child must import the compiled `runtime-owner-lease.js` module using a URL resolved relative to `import.meta.url`; this keeps the test valid from `dist/test`.

- [ ] **Step 2: Add a failing independent-observer regression test**

Create a temporary runtime, acquire `ConnectivityRuntimeOwnerLease` in the parent, and ask an independent Node child to call `ConnectivityRuntimeOwnerLease.inspect(runtimeDir)`. Parse the child's JSON output and assert:

```ts
assert.deepEqual(status, { state: "active", ownerPid: process.pid });
```

Always release the lease and remove the temporary runtime in `finally`.

- [ ] **Step 3: Add a failing independent-contender regression test**

While the parent holds the lease, run another Node child that attempts `acquire()`. The child must report `connectivity_runtime_owned`, and the parent must still satisfy `await lease.isOwner() === true`. This proves a foreign process cannot rename and replace a live lease.

- [ ] **Step 4: Confirm the tests fail for the intended reason**

Run:

```bash
npm run build
node --test --test-force-exit --test-concurrency=1 dist/test/mitm-flow-client.test.js
```

Expected before the fix: the child inspection returns `unowned` or the child contender acquires the lease because the stored self identity and externally observed identity use different formats.

## Task 2: Use one operating-system process identity format

**Files:**
- Modify: `src/connectivity/runtime-owner-lease.ts`
- Test: `test/mitm-flow-client.test.ts`

- [ ] **Step 1: Remove the Node-only self identity**

Delete the `node:perf_hooks` import and `CURRENT_PROCESS_START_IDENTITY`. Remove the `pid === process.pid` special case from `readProcessStartIdentity`.

- [ ] **Step 2: Use Linux `/proc` identity for every PID**

On Linux, read `/proc/<pid>/stat` for both the current process and foreign processes. Extract field 22 (`starttime`) after safely skipping the parenthesized command and return:

```ts
`linux:${pid}:${startTicks}`
```

The lease owner and every observer will now serialize and compare the same value.

- [ ] **Step 3: Keep a consistent non-Linux fallback**

For non-Linux systems, call `ps -o lstart= -p <pid>` for both the current process and foreign processes and retain the existing platform/PID/start-time format. If `/proc` or `ps` cannot be read, return `undefined`; `leaseIsActive` must continue relying conservatively on a live PID and a fresh heartbeat rather than declaring a live owner stale.

- [ ] **Step 4: Run the focused owner tests**

Run:

```bash
npm run build
node --test --test-force-exit --test-concurrency=1 dist/test/mitm-flow-client.test.js dist/test/docker-resource-reaper.test.js
```

Expected: both new cross-process tests pass, existing same-process ownership/reclaim tests pass, and the reaper still skips an active runtime.

- [ ] **Step 5: Commit the ownership fix**

```bash
git add src/connectivity/runtime-owner-lease.ts test/mitm-flow-client.test.ts
git commit -m "fix: preserve runtime ownership across processes"
```

## Task 3: Restrict orphan cleanup to the selected runtime

**Files:**
- Modify: `src/agent-runtime-bootstrap.ts`
- Modify: `src/web-server.ts`
- Modify: `test/agent-runtime-bootstrap.test.ts`
- Modify: `test/docker-resource-reaper.test.ts`

- [ ] **Step 1: Add a reaper boundary regression test**

Extend the fake Docker runner so it can expose resources belonging to two sibling runtime directories. Invoke the reaper with only runtime A as a root and assert that:

- stale resources for runtime A are removed;
- resources for sibling runtime B are not removed;
- no cleanup lease directory is created under runtime B.

This validates the existing `isWithinRoots` boundary before changing callers.

- [ ] **Step 2: Add a bootstrap caller regression test**

In the Docker bootstrap test, use a temporary `cwd` containing an active sibling runtime and pass a different `runtimeDir`. Make the fake Docker runner advertise a managed container under the sibling runtime. Assert bootstrap does not issue `docker rm` for it. This test must fail while bootstrap passes `[input.cwd, input.runtimeDir]`.

- [ ] **Step 3: Narrow bootstrap cleanup**

Change the bootstrap call to:

```ts
await reapStaleManagedDockerResources({
  roots: [input.runtimeDir],
  runner: input.dockerRunner ?? defaultDockerRunner
});
```

`cwd` remains the application/workspace root for controller behavior, but it no longer grants Docker cleanup authority over every runtime nested below it.

- [ ] **Step 4: Narrow Web startup cleanup**

Change Web startup to pass only:

```ts
roots: [runtimePathPolicy.rootDir]
```

This allows the Web process to reap stale resources in its configured runtime while preventing a test Web server or alternate `--runtime-dir` instance from touching the active project runtime.

- [ ] **Step 5: Add a source-level Web wiring assertion**

Extend the existing “CLI and Web run entrypoints” source test to assert that `web-server.ts` calls the reaper with `roots: [runtimePathPolicy.rootDir]` and does not include `cwd` in that roots array. This small wiring test protects the top-level startup path, which is otherwise expensive to import because the module starts a server as a side effect.

- [ ] **Step 6: Run the focused cleanup tests**

Run:

```bash
npm run build
node --test --test-force-exit --test-concurrency=1 dist/test/docker-resource-reaper.test.js dist/test/agent-runtime-bootstrap.test.js
```

Expected: sibling resources remain untouched, the selected runtime's stale resources are still cleaned, and Docker bootstrap behavior remains unchanged apart from cleanup scope.

- [ ] **Step 7: Commit cleanup isolation**

```bash
git add src/agent-runtime-bootstrap.ts src/web-server.ts test/agent-runtime-bootstrap.test.ts test/docker-resource-reaper.test.ts
git commit -m "fix: isolate Docker cleanup by runtime"
```

## Task 4: Verify the complete runtime lifecycle

**Files:**
- Verify: `src/connectivity/runtime-owner-lease.ts`
- Verify: `src/agent-runtime-bootstrap.ts`
- Verify: `src/web-server.ts`
- Verify: `test/mitm-flow-client.test.ts`
- Verify: `test/agent-runtime-bootstrap.test.ts`
- Verify: `test/docker-resource-reaper.test.ts`

- [ ] **Step 1: Run build and focused suites**

```bash
npm run build
node --test --test-force-exit --test-concurrency=1 dist/test/mitm-flow-client.test.js dist/test/agent-runtime-bootstrap.test.js dist/test/docker-resource-reaper.test.js
```

- [ ] **Step 2: Run Web regression tests**

```bash
npm run test:web
```

- [ ] **Step 3: Run the full Node suite sequentially**

```bash
node --test --test-force-exit --test-concurrency=1 "dist/**/*.test.js"
```

Sequential execution is intentional because this fix concerns concurrent process ownership and avoids unrelated parallel test contention obscuring the result.

- [ ] **Step 4: Run the live Docker network smoke test**

```bash
LUANNIAO_DOCKER_LIVE_TEST=1 npm run test:network-live
```

Expected: Gateway/Executor network resources start and stop normally, with no live runtime resources removed by another process.

- [ ] **Step 5: Perform a concurrent local smoke test**

Keep the configured Web panel running on `.agent-runtime`, start a second Web process with a temporary `--runtime-dir`, then inspect Docker events and the active owner record. Verify:

- the active `.agent-runtime` owner remains `active`;
- the original Gateway/task network remains present;
- stopping the temporary Web process cleans only its own resources;
- a new task reaches an Executor epoch instead of immediately becoming blocked with `network ... not found`.

- [ ] **Step 6: Review the final diff and repository state**

```bash
git diff HEAD~2 --check
git status --short
git log -3 --oneline
```

Confirm the unrelated untracked plan `docs/superpowers/plans/2026-08-23-beekeeper-mcp-integration.md` remains untouched.

- [ ] **Step 7: Commit any verification-only corrections**

If verification required a correction, commit only the files belonging to this fix:

```bash
git add src/connectivity/runtime-owner-lease.ts src/agent-runtime-bootstrap.ts src/web-server.ts test/mitm-flow-client.test.ts test/agent-runtime-bootstrap.test.ts test/docker-resource-reaper.test.ts
git commit -m "test: cover runtime cleanup isolation"
```

Do not commit generated runtime data, Docker artifacts, credentials, or the unrelated Beekeeper plan.
