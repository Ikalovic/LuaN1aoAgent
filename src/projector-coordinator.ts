import type { ProjectionState } from "./types.js";

export type ProjectorCoordinatorState = ProjectionState & {
  pendingSince?: string;
  terminalTargetSeq?: number;
};

export type ProjectorCoordinatorStore = {
  raiseDesired(input: {
    taskId: string;
    desiredSeq: number;
    priority: number;
    terminalTargetSeq?: number;
  }): ProjectorCoordinatorState | Promise<ProjectorCoordinatorState>;
  getState(taskId: string): ProjectorCoordinatorState | Promise<ProjectorCoordinatorState>;
  listPending(): ProjectorCoordinatorState[] | Promise<ProjectorCoordinatorState[]>;
  clearTerminalTarget(input: {
    taskId: string;
    terminalTargetSeq: number;
  }): void | Promise<void>;
};

export type ProjectorWorkReason = "live_threshold" | "live_max_age" | "terminal";

export type ProjectorWorkItem = {
  taskId: string;
  fromSeq: number;
  targetSeq: number;
  terminalTargetSeq?: number;
  pendingObservationCount: number;
  maxObservations: number;
  reason: ProjectorWorkReason;
};

export type ProjectorCoordinatorOptions = {
  store: ProjectorCoordinatorStore;
  countObservations(input: {
    taskId: string;
    afterSeq: number;
    toSeq: number;
  }): number | Promise<number>;
  run(input: ProjectorWorkItem, signal: AbortSignal): void | Promise<void>;
  onError?: (error: unknown, input: ProjectorWorkItem) => void | Promise<void>;
  globalConcurrency?: number;
  liveObservationThreshold?: number;
  liveMaxAgeMs?: number;
  normalBatchSize?: number;
  backlogThreshold?: number;
  backlogBatchSize?: number;
  retryDelayMs?: number;
  closeDrainTimeoutMs?: number;
  now?: () => number;
};

export type ProjectorRequest = {
  taskId: string;
  desiredSeq: number;
  priority?: number;
  terminal?: boolean;
};

export type ProjectorCloseResult = {
  drained: boolean;
  pendingTaskIds: string[];
};

type ActiveWork = {
  abortController: AbortController;
  promise: Promise<void>;
};

type CommitWaiter = {
  targetSeq: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
};

const DEFAULT_GLOBAL_CONCURRENCY = 2;
const DEFAULT_LIVE_OBSERVATION_THRESHOLD = 16;
const DEFAULT_LIVE_MAX_AGE_MS = 45_000;
const DEFAULT_NORMAL_BATCH_SIZE = 16;
const DEFAULT_BACKLOG_THRESHOLD = 32;
const DEFAULT_BACKLOG_BATCH_SIZE = 32;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_GRACE_MS = 2_000;

export class ProjectorCoordinator {
  private readonly store: ProjectorCoordinatorStore;
  private readonly countObservations: ProjectorCoordinatorOptions["countObservations"];
  private readonly runWork: ProjectorCoordinatorOptions["run"];
  private readonly onError?: ProjectorCoordinatorOptions["onError"];
  private readonly globalConcurrency: number;
  private readonly liveObservationThreshold: number;
  private readonly liveMaxAgeMs: number;
  private readonly normalBatchSize: number;
  private readonly backlogThreshold: number;
  private readonly backlogBatchSize: number;
  private readonly retryDelayMs: number;
  private readonly closeDrainTimeoutMs: number;
  private readonly now: () => number;
  private readonly activeByTask = new Map<string, ActiveWork>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryNotBefore = new Map<string, number>();
  private readonly waitersByTask = new Map<string, Set<CommitWaiter>>();
  private pumping = false;
  private pumpScheduled = false;
  private pumpAgain = false;
  private accepting = true;
  private drainingOnClose = false;
  private closePromise?: Promise<ProjectorCloseResult>;

  constructor(options: ProjectorCoordinatorOptions) {
    this.store = options.store;
    this.countObservations = options.countObservations;
    this.runWork = options.run;
    this.onError = options.onError;
    this.globalConcurrency = positiveInteger(options.globalConcurrency, DEFAULT_GLOBAL_CONCURRENCY);
    this.liveObservationThreshold = positiveInteger(
      options.liveObservationThreshold,
      DEFAULT_LIVE_OBSERVATION_THRESHOLD
    );
    this.liveMaxAgeMs = nonNegativeInteger(options.liveMaxAgeMs, DEFAULT_LIVE_MAX_AGE_MS);
    this.normalBatchSize = positiveInteger(options.normalBatchSize, DEFAULT_NORMAL_BATCH_SIZE);
    this.backlogThreshold = positiveInteger(options.backlogThreshold, DEFAULT_BACKLOG_THRESHOLD);
    this.backlogBatchSize = positiveInteger(options.backlogBatchSize, DEFAULT_BACKLOG_BATCH_SIZE);
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
    this.closeDrainTimeoutMs = positiveInteger(
      options.closeDrainTimeoutMs,
      DEFAULT_CLOSE_DRAIN_TIMEOUT_MS
    );
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.schedulePump();
  }

  async request(input: ProjectorRequest): Promise<ProjectorCoordinatorState> {
    if (!this.accepting) {
      throw new Error("ProjectorCoordinator is closed");
    }
    const desiredSeq = Math.max(0, Math.floor(input.desiredSeq));
    const state = await this.store.raiseDesired({
      taskId: input.taskId,
      desiredSeq,
      priority: Math.max(0, Math.floor(input.priority ?? 0)),
      terminalTargetSeq: input.terminal ? desiredSeq : undefined
    });
    this.schedulePump();
    return state;
  }

  async flush(taskId: string, targetSeq: number, options: {
    priority?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    await this.request({
      taskId,
      desiredSeq: targetSeq,
      priority: options.priority,
      terminal: true
    });
    await this.waitForCommitted(taskId, targetSeq, options);
  }

  async waitForCommitted(taskId: string, targetSeq: number, options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    const normalizedTarget = Math.max(0, Math.floor(targetSeq));
    const state = await this.store.getState(taskId);
    if (projectionTargetSatisfied(state, normalizedTarget)) {
      return;
    }
    if (!this.accepting && !this.drainingOnClose) {
      throw new Error("ProjectorCoordinator closed before the requested watermark committed");
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: CommitWaiter = {
        targetSeq: normalizedTarget,
        resolve,
        reject,
        signal: options.signal
      };
      if (options.timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.removeWaiter(taskId, waiter);
          reject(new Error(`Timed out waiting for projection ${taskId} to commit through ${normalizedTarget}`));
        }, Math.max(0, options.timeoutMs));
      }
      if (options.signal) {
        waiter.abortListener = () => {
          this.removeWaiter(taskId, waiter);
          reject(options.signal?.reason ?? new Error("Projection watermark wait aborted"));
        };
        if (options.signal.aborted) {
          waiter.abortListener();
          return;
        }
        options.signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      const taskWaiters = this.waitersByTask.get(taskId) ?? new Set<CommitWaiter>();
      taskWaiters.add(waiter);
      this.waitersByTask.set(taskId, taskWaiters);
      void Promise.resolve(this.store.getState(taskId)).then(
        (latestState) => this.resolveCommittedWaiters(taskId, latestState),
        (error) => {
          this.removeWaiter(taskId, waiter);
          reject(error);
        }
      );
    });
  }

  reconcile(): void {
    this.schedulePump();
  }

  async waitForSettled(timeoutMs = 0): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.activeByTask.size > 0 || this.pumping || this.pumpScheduled) {
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
    return true;
  }

  close(options: { drain?: boolean; timeoutMs?: number; cancelGraceMs?: number } = {}): Promise<ProjectorCloseResult> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal(options);
    }
    return this.closePromise;
  }

  private async closeInternal(options: {
    drain?: boolean;
    timeoutMs?: number;
    cancelGraceMs?: number;
  }): Promise<ProjectorCloseResult> {
    if (!this.accepting && !this.drainingOnClose) {
      return this.closeResult(true);
    }
    this.accepting = false;
    this.clearWakeTimers();
    if (options.drain !== false) {
      this.drainingOnClose = true;
      const pending = await this.store.listPending();
      await Promise.all(pending.map((state) => this.store.raiseDesired({
        taskId: state.taskId,
        desiredSeq: state.desiredSeq,
        priority: Math.max(10, state.priority),
        terminalTargetSeq: state.desiredSeq
      })));
      this.schedulePump();
      const drained = await this.waitForDrain(options.timeoutMs ?? this.closeDrainTimeoutMs);
      this.drainingOnClose = false;
      if (!drained) {
        await this.abortActiveWork(
          new Error("ProjectorCoordinator close drain timed out"),
          options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
        );
      }
      const result = await this.closeResult(drained);
      this.rejectOutstandingWaiters(new Error("ProjectorCoordinator closed before the requested watermark committed"));
      return result;
    }
    this.drainingOnClose = false;
    await this.abortActiveWork(
      new Error("ProjectorCoordinator closed without draining"),
      options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
    );
    const result = await this.closeResult(false);
    this.rejectOutstandingWaiters(new Error("ProjectorCoordinator closed before the requested watermark committed"));
    return result;
  }

  private schedulePump(): void {
    if (!this.accepting && !this.drainingOnClose) {
      return;
    }
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || (!this.accepting && !this.drainingOnClose)) {
      return;
    }
    this.pumping = true;
    try {
      while (this.activeByTask.size < this.globalConcurrency) {
        const work = await this.nextWork();
        if (!work) {
          return;
        }
        if (!this.accepting && !this.drainingOnClose) {
          return;
        }
        this.startWork(work);
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.schedulePump();
      }
    }
  }

  private async nextWork(): Promise<ProjectorWorkItem | undefined> {
    const states = (await this.store.listPending())
      .filter((state) => state.desiredSeq > state.committedSeq || state.terminalTargetSeq !== undefined)
      .filter((state) => state.activeGeneration === undefined)
      .filter((state) => !this.activeByTask.has(state.taskId))
      .sort(compareProjectionStates);
    for (const state of states) {
      const retryAt = this.retryNotBefore.get(state.taskId) ?? 0;
      if (retryAt > this.now()) {
        this.scheduleWake(state.taskId, retryAt - this.now());
        continue;
      }
      const terminalTargetSeq = state.terminalTargetSeq;
      if (terminalTargetSeq !== undefined && state.committedSeq >= terminalTargetSeq) {
        await this.store.clearTerminalTarget({ taskId: state.taskId, terminalTargetSeq });
        const cleared = await this.store.getState(state.taskId);
        await this.resolveCommittedWaiters(state.taskId, cleared);
        continue;
      }
      const targetSeq = terminalTargetSeq === undefined
        ? state.desiredSeq
        : Math.min(state.desiredSeq, terminalTargetSeq);
      const pendingObservationCount = await this.countObservations({
        taskId: state.taskId,
        afterSeq: state.committedSeq,
        toSeq: targetSeq
      });
      const pendingAgeMs = Math.max(0, this.now() - stateTimestamp(state));
      let reason: ProjectorWorkReason | undefined;
      if (terminalTargetSeq !== undefined) {
        reason = "terminal";
      } else if (pendingObservationCount >= this.liveObservationThreshold) {
        reason = "live_threshold";
      } else if (pendingAgeMs >= this.liveMaxAgeMs) {
        reason = "live_max_age";
      } else {
        this.scheduleWake(state.taskId, this.liveMaxAgeMs - pendingAgeMs);
      }
      if (!reason) {
        continue;
      }
      this.clearWake(state.taskId);
      return {
        taskId: state.taskId,
        fromSeq: state.committedSeq,
        targetSeq,
        terminalTargetSeq,
        pendingObservationCount,
        maxObservations: pendingObservationCount > this.backlogThreshold
          ? this.backlogBatchSize
          : this.normalBatchSize,
        reason
      };
    }
    return undefined;
  }

  private startWork(work: ProjectorWorkItem): void {
    const abortController = new AbortController();
    const active: ActiveWork = {
      abortController,
      promise: Promise.resolve()
    };
    this.activeByTask.set(work.taskId, active);
    active.promise = this.executeWork(work, abortController.signal)
      .catch(async (error) => {
        this.retryNotBefore.set(work.taskId, this.now() + this.retryDelayMs);
        this.scheduleWake(work.taskId, this.retryDelayMs);
        try {
          await this.onError?.(error, work);
        } catch {
        }
      })
      .finally(() => {
        this.activeByTask.delete(work.taskId);
        this.schedulePump();
      });
  }

  private async executeWork(work: ProjectorWorkItem, signal: AbortSignal): Promise<void> {
    let failed = false;
    try {
      await this.runWork(work, signal);
    } catch (error) {
      failed = true;
      try {
        await this.onError?.(error, work);
      } catch {
      }
    }
    if (signal.aborted) {
      return;
    }
    let state = await this.store.getState(work.taskId);
    if (
      !failed
      && state.terminalTargetSeq !== undefined
      && state.committedSeq >= state.terminalTargetSeq
    ) {
      await this.store.clearTerminalTarget({
        taskId: work.taskId,
        terminalTargetSeq: state.terminalTargetSeq
      });
      state = await this.store.getState(work.taskId);
    }
    await this.resolveCommittedWaiters(work.taskId, state);
    if (failed || (state.desiredSeq > state.committedSeq && state.committedSeq <= work.fromSeq)) {
      this.retryNotBefore.set(work.taskId, this.now() + this.retryDelayMs);
      this.scheduleWake(work.taskId, this.retryDelayMs);
    } else {
      this.retryNotBefore.delete(work.taskId);
    }
  }

  private scheduleWake(taskId: string, delayMs: number): void {
    if ((!this.accepting && !this.drainingOnClose) || this.wakeTimers.has(taskId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.wakeTimers.delete(taskId);
      this.schedulePump();
    }, Math.max(0, delayMs));
    this.wakeTimers.set(taskId, timer);
  }

  private clearWake(taskId: string): void {
    const timer = this.wakeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.wakeTimers.delete(taskId);
    }
  }

  private clearWakeTimers(): void {
    for (const timer of this.wakeTimers.values()) {
      clearTimeout(timer);
    }
    this.wakeTimers.clear();
  }

  private async waitForDrain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const pending = await this.store.listPending();
      if (
        pending.length === 0
        && this.activeByTask.size === 0
        && !this.pumping
        && !this.pumpScheduled
      ) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }

  private async abortActiveWork(reason: Error, graceMs: number): Promise<boolean> {
    for (const work of this.activeByTask.values()) {
      work.abortController.abort(reason);
    }
    this.clearWakeTimers();
    return this.waitForSettled(graceMs);
  }

  private async closeResult(drained: boolean): Promise<ProjectorCloseResult> {
    const pending = await this.store.listPending();
    return {
      drained: drained && pending.length === 0,
      pendingTaskIds: pending.map((state) => state.taskId)
    };
  }

  private async resolveCommittedWaiters(taskId: string, state: ProjectorCoordinatorState): Promise<void> {
    const waiters = this.waitersByTask.get(taskId);
    if (!waiters) {
      return;
    }
    for (const waiter of [...waiters]) {
      if (!projectionTargetSatisfied(state, waiter.targetSeq)) {
        continue;
      }
      this.removeWaiter(taskId, waiter);
      waiter.resolve();
    }
  }

  private removeWaiter(taskId: string, waiter: CommitWaiter): void {
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    const waiters = this.waitersByTask.get(taskId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) {
      this.waitersByTask.delete(taskId);
    }
  }

  private rejectOutstandingWaiters(error: Error): void {
    for (const [taskId, waiters] of this.waitersByTask) {
      for (const waiter of [...waiters]) {
        this.removeWaiter(taskId, waiter);
        waiter.reject(error);
      }
    }
  }
}

function compareProjectionStates(left: ProjectorCoordinatorState, right: ProjectorCoordinatorState): number {
  const leftTerminal = left.terminalTargetSeq !== undefined;
  const rightTerminal = right.terminalTargetSeq !== undefined;
  if (leftTerminal !== rightTerminal) {
    return leftTerminal ? -1 : 1;
  }
  return right.priority - left.priority
    || stateTimestamp(left) - stateTimestamp(right)
    || left.taskId.localeCompare(right.taskId);
}

function projectionTargetSatisfied(state: ProjectorCoordinatorState, targetSeq: number): boolean {
  return state.committedSeq >= targetSeq
    && !(state.terminalTargetSeq !== undefined && state.terminalTargetSeq <= targetSeq);
}

function stateTimestamp(state: ProjectorCoordinatorState): number {
  const timestamp = Date.parse(state.pendingSince ?? state.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
