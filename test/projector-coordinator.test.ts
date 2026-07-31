import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ProjectorCoordinator,
  type ProjectorCoordinatorState,
  type ProjectorCoordinatorStore,
  type ProjectorWorkItem
} from "../src/projector-coordinator.js";

class FakeProjectionStore implements ProjectorCoordinatorStore {
  readonly states = new Map<string, ProjectorCoordinatorState>();
  private now = Date.now();

  seed(input: {
    taskId: string;
    committedSeq?: number;
    desiredSeq: number;
    terminalTargetSeq?: number;
    priority?: number;
  }): void {
    this.states.set(input.taskId, {
      taskId: input.taskId,
      committedSeq: input.committedSeq ?? 0,
      desiredSeq: input.desiredSeq,
      generation: 0,
      priority: input.priority ?? 0,
      updatedAt: new Date(this.now).toISOString(),
      pendingSince: new Date(this.now).toISOString(),
      terminalTargetSeq: input.terminalTargetSeq
    });
  }

  raiseDesired(input: {
    taskId: string;
    desiredSeq: number;
    priority: number;
    terminalTargetSeq?: number;
  }): ProjectorCoordinatorState {
    const existing = this.states.get(input.taskId);
    const wasCaughtUp = !existing || existing.desiredSeq <= existing.committedSeq;
    const state: ProjectorCoordinatorState = {
      taskId: input.taskId,
      committedSeq: existing?.committedSeq ?? 0,
      desiredSeq: Math.max(existing?.desiredSeq ?? 0, input.desiredSeq),
      generation: existing?.generation ?? 0,
      activeGeneration: existing?.activeGeneration,
      priority: Math.max(existing?.priority ?? 0, input.priority),
      updatedAt: new Date(this.now).toISOString(),
      pendingSince: wasCaughtUp ? new Date(this.now).toISOString() : existing?.pendingSince,
      terminalTargetSeq: input.terminalTargetSeq === undefined
        ? existing?.terminalTargetSeq
        : Math.max(existing?.terminalTargetSeq ?? 0, input.terminalTargetSeq)
    };
    this.states.set(input.taskId, state);
    return { ...state };
  }

  getState(taskId: string): ProjectorCoordinatorState {
    const state = this.states.get(taskId);
    if (!state) {
      throw new Error(`Missing fake projection state: ${taskId}`);
    }
    return { ...state };
  }

  listPending(): ProjectorCoordinatorState[] {
    return [...this.states.values()]
      .filter((state) => state.desiredSeq > state.committedSeq || state.terminalTargetSeq !== undefined)
      .map((state) => ({ ...state }));
  }

  clearTerminalTarget(input: { taskId: string; terminalTargetSeq: number }): void {
    const state = this.getMutable(input.taskId);
    if (state.terminalTargetSeq === input.terminalTargetSeq) {
      state.terminalTargetSeq = undefined;
    }
  }

  commit(taskId: string, committedSeq: number): void {
    const state = this.getMutable(taskId);
    state.committedSeq = Math.max(state.committedSeq, committedSeq);
    state.activeGeneration = undefined;
    state.pendingSince = state.committedSeq < state.desiredSeq
      ? new Date(this.now).toISOString()
      : undefined;
    state.updatedAt = new Date(this.now).toISOString();
  }

  advanceTime(ms: number): void {
    this.now += ms;
  }

  private getMutable(taskId: string): ProjectorCoordinatorState {
    const state = this.states.get(taskId);
    if (!state) {
      throw new Error(`Missing fake projection state: ${taskId}`);
    }
    return state;
  }
}

test("runs at most two tasks concurrently and never overlaps one task", async () => {
  const store = new FakeProjectionStore();
  const releases = new Map<string, () => void>();
  const starts: string[] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: async (work) => {
      starts.push(work.taskId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(work.taskId, resolve));
      active -= 1;
      store.commit(work.taskId, work.targetSeq);
    },
    liveObservationThreshold: 1,
    liveMaxAgeMs: 60_000
  });

  await Promise.all([
    coordinator.request({ taskId: "task:a", desiredSeq: 1 }),
    coordinator.request({ taskId: "task:a", desiredSeq: 2 }),
    coordinator.request({ taskId: "task:b", desiredSeq: 1 }),
    coordinator.request({ taskId: "task:c", desiredSeq: 1 })
  ]);
  await waitFor(() => starts.length === 2);
  assert.equal(new Set(starts).size, 2);
  assert.equal(maxActive, 2);

  releases.get(starts[0] ?? "")?.();
  await waitFor(() => starts.length === 3);
  assert.equal(maxActive, 2);
  for (const release of releases.values()) {
    release();
  }
  await waitFor(() => store.listPending().length === 0);
  await coordinator.close();
  assert.equal(starts.filter((taskId) => taskId === "task:a").length, 1);
});

test("delays small live tails but runs threshold and max-age work", async () => {
  const store = new FakeProjectionStore();
  const runs: ProjectorWorkItem[] = [];
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: (work) => {
      runs.push(work);
      store.commit(work.taskId, work.targetSeq);
    },
    liveMaxAgeMs: 25
  });

  await coordinator.request({ taskId: "task:small", desiredSeq: 15 });
  await delay(5);
  assert.equal(runs.length, 0);
  await coordinator.request({ taskId: "task:threshold", desiredSeq: 16 });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0]?.reason, "live_threshold");
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1]?.taskId, "task:small");
  assert.equal(runs[1]?.reason, "live_max_age");
  await coordinator.close();
});

test("uses adaptive batches and continuously drains a terminal target", async () => {
  const store = new FakeProjectionStore();
  const runs: ProjectorWorkItem[] = [];
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: (work) => {
      runs.push(work);
      store.commit(work.taskId, Math.min(work.targetSeq, work.fromSeq + work.maxObservations));
    },
    liveMaxAgeMs: 60_000
  });

  await coordinator.flush("task:terminal", 40, { timeoutMs: 1_000 });
  assert.deepEqual(runs.map((work) => work.maxObservations), [32, 16]);
  assert.ok(runs.every((work) => work.reason === "terminal"));
  assert.equal(store.getState("task:terminal").committedSeq, 40);
  assert.equal(store.getState("task:terminal").terminalTargetSeq, undefined);
  await coordinator.close();
});

test("clears a caught-up terminal fence without a second projector invocation", async () => {
  const store = new FakeProjectionStore();
  const runs: ProjectorWorkItem[] = [];
  store.seed({
    taskId: "task:association-only",
    committedSeq: 3,
    desiredSeq: 3,
    terminalTargetSeq: 3,
    priority: 10
  });
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: async (work) => {
      runs.push(work);
    }
  });

  coordinator.start();
  await coordinator.waitForCommitted("task:association-only", 3, { timeoutMs: 1_000 });
  assert.deepEqual(runs, []);
  assert.equal(store.getState("task:association-only").terminalTargetSeq, undefined);
  await coordinator.close();
});

test("recovers persisted pending state and close drains sub-threshold tails", async () => {
  const store = new FakeProjectionStore();
  const runs: string[] = [];
  store.seed({ taskId: "task:recovered", desiredSeq: 3, terminalTargetSeq: 3, priority: 10 });
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: (work) => {
      runs.push(work.taskId);
      store.commit(work.taskId, work.targetSeq);
    },
    liveMaxAgeMs: 60_000
  });

  coordinator.start();
  await waitFor(() => store.getState("task:recovered").committedSeq === 3);
  await coordinator.request({ taskId: "task:close-tail", desiredSeq: 2 });
  const result = await coordinator.close({ drain: true, timeoutMs: 1_000 });

  assert.deepEqual(result, { drained: true, pendingTaskIds: [] });
  assert.deepEqual(runs, ["task:recovered", "task:close-tail"]);
  assert.equal(store.getState("task:close-tail").committedSeq, 2);
});

test("owns retry timing after a failed projector callback", async () => {
  const store = new FakeProjectionStore();
  let attempts = 0;
  let reportedErrors = 0;
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: (work) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient projector failure");
      }
      store.commit(work.taskId, work.targetSeq);
    },
    onError: () => {
      reportedErrors += 1;
    },
    liveObservationThreshold: 1,
    retryDelayMs: 10
  });

  await coordinator.request({ taskId: "task:retry", desiredSeq: 1 });
  await coordinator.waitForCommitted("task:retry", 1, { timeoutMs: 1_000 });

  assert.equal(attempts, 2);
  assert.equal(reportedErrors, 1);
  await coordinator.close();
});

test("terminal work can advance an empty observation range without a parked state", async () => {
  const store = new FakeProjectionStore();
  let attempts = 0;
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: () => 0,
    run: (work) => {
      attempts += 1;
      store.commit(work.taskId, work.targetSeq);
    },
    retryDelayMs: 10
  });

  await coordinator.request({
    taskId: "task:waiting-interpretation",
    desiredSeq: 1,
    terminal: true
  });
  await coordinator.waitForCommitted("task:waiting-interpretation", 1, { timeoutMs: 1_000 });
  assert.equal(attempts, 1);
  assert.equal(store.getState("task:waiting-interpretation").committedSeq, 1);
  await coordinator.close();
});

test("backs off repeated retries exponentially up to a cap and resets after progress", async () => {
  const store = new FakeProjectionStore();
  const attemptTimes: number[] = [];
  const batchSizes: number[] = [];
  const retryAttempts: number[] = [];
  let attempts = 0;
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: (work) => {
      attempts += 1;
      attemptTimes.push(Date.now());
      batchSizes.push(work.maxObservations);
      retryAttempts.push(work.retryAttempt);
      if (attempts <= 4 || attempts === 6) {
        throw new Error(`failure ${attempts}`);
      }
      store.commit(work.taskId, work.targetSeq);
    },
    liveObservationThreshold: 1,
    retryDelayMs: 25,
    maxRetryDelayMs: 60
  });

  await coordinator.request({ taskId: "task:backoff", desiredSeq: 1 });
  await coordinator.waitForCommitted("task:backoff", 1, { timeoutMs: 2_000 });
  assert.equal(attempts, 5);
  assert.deepEqual(batchSizes, [16, 8, 4, 2, 1]);
  assert.deepEqual(retryAttempts, [0, 1, 2, 3, 4]);

  const gap = (index: number) => attemptTimes[index]! - attemptTimes[index - 1]!;
  assert.ok(gap(1) >= 20, `first retry gap ${gap(1)}ms, expected ~25ms base delay`);
  assert.ok(gap(2) >= 45, `second retry gap ${gap(2)}ms, expected ~50ms doubled delay`);
  assert.ok(gap(3) < gap(2) * 1.5, `third retry gap ${gap(3)}ms should be capped near 60ms, not double again`);
  assert.ok(gap(4) < gap(2) * 1.5, `fourth retry gap ${gap(4)}ms should stay at the cap`);

  await coordinator.request({ taskId: "task:backoff", desiredSeq: 2 });
  await coordinator.waitForCommitted("task:backoff", 2, { timeoutMs: 2_000 });
  assert.equal(attempts, 7);
  assert.deepEqual(batchSizes.slice(5), [16, 8]);
  assert.deepEqual(retryAttempts.slice(5), [0, 1]);
  assert.ok(
    gap(6) >= 20 && gap(6) < 45,
    `retry after progress ${gap(6)}ms should reset to the ~25ms base delay`
  );
  await coordinator.close();
});

test("stops replaying an unchanged failing target until new observations arrive", async () => {
  const store = new FakeProjectionStore();
  const runs: ProjectorWorkItem[] = [];
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: (work) => {
      runs.push(work);
      throw new Error("deterministic projection failure");
    },
    liveObservationThreshold: 1,
    retryDelayMs: 1,
    maxRetryDelayMs: 1,
    maxConsecutiveFailures: 3
  });

  await coordinator.request({ taskId: "task:fixed-failure", desiredSeq: 1 });
  await waitFor(() => runs.length === 3);
  await delay(20);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((work) => work.maxObservations), [16, 8, 4]);

  await coordinator.request({ taskId: "task:fixed-failure", desiredSeq: 2 });
  await waitFor(() => runs.length === 6);
  assert.deepEqual(runs.slice(3).map((work) => work.retryAttempt), [0, 1, 2]);
  await coordinator.close({ drain: false });
});

test("keeps the process alive while a persisted retry is awaited", () => {
  const moduleUrl = new URL("../src/projector-coordinator.js", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { ProjectorCoordinator } from ${JSON.stringify(moduleUrl)};
      const state = {
        taskId: "task:retry-process",
        committedSeq: 0,
        desiredSeq: 0,
        generation: 0,
        priority: 0,
        updatedAt: new Date().toISOString()
      };
      const store = {
        raiseDesired(input) {
          state.desiredSeq = Math.max(state.desiredSeq, input.desiredSeq);
          state.priority = Math.max(state.priority, input.priority);
          state.terminalTargetSeq = input.terminalTargetSeq ?? state.terminalTargetSeq;
          state.pendingSince ??= new Date().toISOString();
          state.updatedAt = new Date().toISOString();
          return { ...state };
        },
        getState() {
          return { ...state };
        },
        listPending() {
          return state.desiredSeq > state.committedSeq || state.terminalTargetSeq !== undefined
            ? [{ ...state }]
            : [];
        },
        clearTerminalTarget(input) {
          if (state.terminalTargetSeq === input.terminalTargetSeq) {
            state.terminalTargetSeq = undefined;
          }
        }
      };
      let attempts = 0;
      const coordinator = new ProjectorCoordinator({
        store,
        countObservations: ({ afterSeq, toSeq }) => toSeq - afterSeq,
        run(work) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient failure");
          }
          state.committedSeq = work.targetSeq;
          state.pendingSince = undefined;
          state.updatedAt = new Date().toISOString();
        },
        liveObservationThreshold: 1,
        retryDelayMs: 25
      });
      await coordinator.request({ taskId: state.taskId, desiredSeq: 1, terminal: true });
      await coordinator.waitForCommitted(state.taskId, 1);
      await coordinator.close();
      console.log(JSON.stringify({ attempts, committedSeq: state.committedSeq }));
    `
  ], {
    encoding: "utf8",
    timeout: 5_000
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { attempts: 2, committedSeq: 1 });
});

test("keeps the process alive until a projection wait timeout settles", () => {
  const moduleUrl = new URL("../src/projector-coordinator.js", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { ProjectorCoordinator } from ${JSON.stringify(moduleUrl)};
      const state = {
        taskId: "task:timeout-process",
        committedSeq: 0,
        desiredSeq: 1,
        generation: 0,
        priority: 0,
        pendingSince: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const coordinator = new ProjectorCoordinator({
        store: {
          raiseDesired() { return { ...state }; },
          getState() { return { ...state }; },
          listPending() { return [{ ...state }]; },
          clearTerminalTarget() {}
        },
        countObservations: () => 0,
        run() {},
        liveMaxAgeMs: 60_000
      });
      let timedOut = false;
      try {
        await coordinator.waitForCommitted(state.taskId, 1, { timeoutMs: 25 });
      } catch (error) {
        timedOut = String(error).includes("Timed out waiting for projection");
      }
      await coordinator.close({ drain: false });
      console.log(JSON.stringify({ timedOut }));
    `
  ], {
    encoding: "utf8",
    timeout: 5_000
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { timedOut: true });
});

test("concurrent close calls join the same active shutdown", async () => {
  const store = new FakeProjectionStore();
  const release = createDeferred<void>();
  let started = false;
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: async () => {
      started = true;
      await release.promise;
    },
    liveObservationThreshold: 1
  });

  await coordinator.request({ taskId: "task:closing", desiredSeq: 1 });
  await waitFor(() => started);
  const firstClose = coordinator.close({ drain: false });
  let secondResolved = false;
  const secondClose = coordinator.close({ drain: true }).then((result) => {
    secondResolved = true;
    return result;
  });
  await delay(5);
  assert.equal(secondResolved, false);

  release.resolve();
  const [firstResult, secondResult] = await Promise.all([firstClose, secondClose]);
  assert.deepEqual(secondResult, firstResult);
  assert.deepEqual(firstResult, { drained: false, pendingTaskIds: ["task:closing"] });
});

test("close returns after cancel grace when projector work ignores abort", async () => {
  const store = new FakeProjectionStore();
  const release = createDeferred<void>();
  let started = false;
  const coordinator = new ProjectorCoordinator({
    store,
    countObservations: ({ toSeq, afterSeq }) => toSeq - afterSeq,
    run: async () => {
      started = true;
      await release.promise;
    },
    liveObservationThreshold: 1
  });

  await coordinator.request({ taskId: "task:ignores-abort", desiredSeq: 1 });
  await waitFor(() => started);
  const startedAt = Date.now();
  const result = await coordinator.close({ drain: false, cancelGraceMs: 10 });

  assert.equal(result.drained, false);
  assert.deepEqual(result.pendingTaskIds, ["task:ignores-abort"]);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(await coordinator.waitForSettled(0), false);
  release.resolve();
  assert.equal(await coordinator.waitForSettled(1_000), true);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for projector coordinator state");
    }
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
