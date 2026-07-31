export type EpochBudgetClockSnapshot = {
  epochId: string;
  timeLimitMs: number;
  deadlineAt: number;
  pausedAt?: number;
  accumulatedPauseMs: number;
};

export type EpochBudgetClockRuntime = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

const systemRuntime: EpochBudgetClockRuntime = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer)
};

export class EpochBudgetClock {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly runtime: EpochBudgetClockRuntime;
  private readonly persist: (snapshot: EpochBudgetClockSnapshot) => void;
  private readonly onExpire: () => void;
  private state: EpochBudgetClockSnapshot;

  constructor(input: {
    epochId: string;
    timeLimitMs: number;
    onExpire: () => void;
    persist?: (snapshot: EpochBudgetClockSnapshot) => void;
    runtime?: EpochBudgetClockRuntime;
  }) {
    this.runtime = input.runtime ?? systemRuntime;
    this.persist = input.persist ?? (() => undefined);
    this.onExpire = input.onExpire;
    const timeLimitMs = Math.max(1, Math.floor(input.timeLimitMs));
    this.state = {
      epochId: input.epochId,
      timeLimitMs,
      deadlineAt: this.runtime.now() + timeLimitMs,
      accumulatedPauseMs: 0
    };
    this.persist({ ...this.state });
    this.arm();
  }

  pause(): boolean {
    if (this.state.pausedAt !== undefined) return false;
    const next = { ...this.state, pausedAt: this.runtime.now() };
    this.persist(next);
    this.state = next;
    this.cancelTimer();
    return true;
  }

  resume(): number {
    if (this.state.pausedAt === undefined) return 0;
    const now = this.runtime.now();
    const pauseMs = Math.max(0, now - this.state.pausedAt);
    const next = {
      ...this.state,
      deadlineAt: this.state.deadlineAt + pauseMs,
      accumulatedPauseMs: this.state.accumulatedPauseMs + pauseMs,
      pausedAt: undefined
    };
    this.persist(next);
    this.state = next;
    this.arm();
    return pauseMs;
  }

  stop(): void {
    this.cancelTimer();
  }

  snapshot(): EpochBudgetClockSnapshot & { remainingMs: number } {
    const referenceTime = this.state.pausedAt ?? this.runtime.now();
    return {
      ...this.state,
      remainingMs: Math.max(0, this.state.deadlineAt - referenceTime)
    };
  }

  private arm(): void {
    this.cancelTimer();
    const remainingMs = this.snapshot().remainingMs;
    this.timer = this.runtime.setTimeout(() => {
      this.timer = undefined;
      this.onExpire();
    }, Math.max(1, remainingMs));
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    this.runtime.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
