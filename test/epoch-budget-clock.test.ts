import assert from "node:assert/strict";
import test from "node:test";
import {
  EpochBudgetClock,
  type EpochBudgetClockRuntime,
  type EpochBudgetClockSnapshot
} from "../src/epoch-budget-clock.js";

test("epoch budget clock freezes remaining time and persists each transition", () => {
  let now = 1_000;
  let nextTimerId = 0;
  const callbacks = new Map<number, () => void>();
  const runtime: EpochBudgetClockRuntime = {
    now: () => now,
    setTimeout: (callback) => {
      nextTimerId += 1;
      callbacks.set(nextTimerId, callback);
      return nextTimerId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      callbacks.delete(timer as unknown as number);
    }
  };
  const persisted: EpochBudgetClockSnapshot[] = [];
  let expirations = 0;
  const clock = new EpochBudgetClock({
    epochId: "epoch:test",
    timeLimitMs: 500,
    runtime,
    persist: (snapshot) => persisted.push(snapshot),
    onExpire: () => { expirations += 1; }
  });

  assert.deepEqual(clock.snapshot(), {
    epochId: "epoch:test",
    timeLimitMs: 500,
    deadlineAt: 1_500,
    accumulatedPauseMs: 0,
    remainingMs: 500
  });
  now = 1_100;
  assert.equal(clock.pause(), true);
  assert.equal(clock.pause(), false);
  assert.equal(clock.snapshot().remainingMs, 400);
  assert.equal(callbacks.size, 0);

  now = 1_350;
  assert.equal(clock.snapshot().remainingMs, 400);
  assert.equal(clock.resume(), 250);
  assert.deepEqual(clock.snapshot(), {
    epochId: "epoch:test",
    timeLimitMs: 500,
    deadlineAt: 1_750,
    pausedAt: undefined,
    accumulatedPauseMs: 250,
    remainingMs: 400
  });
  assert.equal(callbacks.size, 1);
  assert.equal(persisted.length, 3);

  const callback = [...callbacks.values()][0];
  callback?.();
  assert.equal(expirations, 1);
});

test("epoch budget clock keeps its prior timer when a transition cannot be persisted", () => {
  let now = 1_000;
  let persistCalls = 0;
  const callbacks = new Set<ReturnType<typeof setTimeout>>();
  const runtime: EpochBudgetClockRuntime = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      callbacks.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      callbacks.delete(timer);
      clearTimeout(timer);
    }
  };
  const clock = new EpochBudgetClock({
    epochId: "epoch:persist-failure",
    timeLimitMs: 60_000,
    runtime,
    persist: () => {
      persistCalls += 1;
      if (persistCalls > 1) throw new Error("database unavailable");
    },
    onExpire: () => undefined
  });

  now = 1_100;
  assert.throws(() => clock.pause(), /database unavailable/);
  assert.equal(clock.snapshot().pausedAt, undefined);
  assert.equal(callbacks.size, 1);
  clock.stop();
});
