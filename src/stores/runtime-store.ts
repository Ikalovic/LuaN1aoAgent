import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionEpochRecord,
  ExecutionEpochState,
  ExecutionEpochTerminationReason,
  EpochOutcome,
  ProjectionClaim,
  ProjectionState,
  TaskOutcome
} from "../types.js";
import type { EpochBudgetClockSnapshot } from "../epoch-budget-clock.js";
import { FofaError } from "../fofa/fofa-types.js";

export type ExecutorSessionRecord = {
  taskId: string;
  sessionFile: string;
  workspaceKey: string;
  resumeCount: number;
  updatedAt: string;
};

export function getOrCreateRuntimeRunRef(databasePath: string): string {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    ensureRuntimeMetadataTable(database);
    return getOrCreateRunRefInDatabase(database);
  } finally {
    database.close();
  }
}

type EpochRow = {
  epoch_id: string;
  task_id: string;
  attempt: number;
  state: ExecutionEpochState;
  termination_reason: ExecutionEpochTerminationReason | null;
  started_at: string;
  closed_at: string | null;
  start_seq: number | null;
  end_seq: number | null;
};

type ProjectionRow = {
  task_id: string;
  committed_seq: number;
  desired_seq: number;
  generation: number;
  active_generation: number | null;
  priority: number;
  pending_since: string | null;
  terminal_target_seq: number | null;
  updated_at: string;
};

type ExecutorSessionRow = {
  task_id: string;
  session_file: string;
  workspace_key: string | null;
  resume_count: number;
  updated_at: string;
};

type TaskOutcomeRow = {
  task_id: string;
  epoch_id: string;
  terminal_seq: number;
  outcome_json: string;
  created_at: string;
};

type EpochOutcomeRow = {
  epoch_id: string;
  task_id: string;
  terminal_seq: number;
  outcome_json: string;
  created_at: string;
};

type EpochBudgetRow = {
  epoch_id: string;
  time_limit_ms: number;
  deadline_at: number;
  paused_at: number | null;
  accumulated_pause_ms: number;
  updated_at: string;
};

export class RuntimeStore {
  readonly databasePath: string;
  readonly recoveredProjectionClaims: number;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
    this.recoverInterruptedEpochs();
    this.recoveredProjectionClaims = this.recoverInterruptedProjectionClaims();
  }

  close(): void {
    this.database.close();
  }

  getOrCreateRunRef(): string {
    return getOrCreateRunRefInDatabase(this.database);
  }

  createEpoch(input: {
    epochId: string;
    taskId: string;
    attempt: number;
    startSeq?: number;
  }): ExecutionEpochRecord {
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO execution_epochs (
        epoch_id, task_id, attempt, state, termination_reason,
        started_at, closed_at, start_seq, end_seq
      ) VALUES (?, ?, ?, 'created', NULL, ?, NULL, ?, NULL)
    `).run(input.epochId, input.taskId, input.attempt, startedAt, input.startSeq ?? null);
    return {
      epochId: input.epochId,
      taskId: input.taskId,
      attempt: input.attempt,
      state: "created",
      startedAt,
      startSeq: input.startSeq
    };
  }

  transitionEpoch(input: {
    epochId: string;
    state: ExecutionEpochState;
    terminationReason?: ExecutionEpochTerminationReason;
    endSeq?: number;
  }): ExecutionEpochRecord {
    const closedAt = input.state === "closed" ? new Date().toISOString() : null;
    const result = this.database.prepare(`
      UPDATE execution_epochs
      SET state = ?, termination_reason = COALESCE(?, termination_reason),
          closed_at = COALESCE(?, closed_at), end_seq = COALESCE(?, end_seq)
      WHERE epoch_id = ?
    `).run(
      input.state,
      input.terminationReason ?? null,
      closedAt,
      input.endSeq ?? null,
      input.epochId
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`Execution epoch not found: ${input.epochId}`);
    }
    const record = this.getEpoch(input.epochId);
    if (!record) {
      throw new Error(`Execution epoch disappeared after transition: ${input.epochId}`);
    }
    return record;
  }

  getEpoch(epochId: string): ExecutionEpochRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM execution_epochs WHERE epoch_id = ?
    `).get(epochId) as EpochRow | undefined;
    return row ? epochRowToRecord(row) : undefined;
  }

  countTaskEpochs(taskId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM execution_epochs WHERE task_id = ?
    `).get(taskId) as { count: number };
    return Number(row.count);
  }

  upsertEpochBudget(snapshot: EpochBudgetClockSnapshot): void {
    this.database.prepare(`
      INSERT INTO epoch_budgets (
        epoch_id, time_limit_ms, deadline_at, paused_at, accumulated_pause_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(epoch_id) DO UPDATE SET
        time_limit_ms = excluded.time_limit_ms,
        deadline_at = excluded.deadline_at,
        paused_at = excluded.paused_at,
        accumulated_pause_ms = excluded.accumulated_pause_ms,
        updated_at = excluded.updated_at
    `).run(
      snapshot.epochId,
      snapshot.timeLimitMs,
      snapshot.deadlineAt,
      snapshot.pausedAt ?? null,
      snapshot.accumulatedPauseMs,
      new Date().toISOString()
    );
  }

  getEpochBudget(epochId: string): EpochBudgetClockSnapshot | undefined {
    const row = this.database.prepare(`
      SELECT * FROM epoch_budgets WHERE epoch_id = ?
    `).get(epochId) as EpochBudgetRow | undefined;
    return row ? {
      epochId: row.epoch_id,
      timeLimitMs: Number(row.time_limit_ms),
      deadlineAt: Number(row.deadline_at),
      pausedAt: row.paused_at ?? undefined,
      accumulatedPauseMs: Number(row.accumulated_pause_ms)
    } : undefined;
  }

  stats(): Record<string, unknown> {
    const byState = Object.fromEntries((this.database.prepare(`
      SELECT state, COUNT(*) AS count FROM execution_epochs GROUP BY state ORDER BY state
    `).all() as Array<{ state: string; count: number }>).map((row) => [row.state, Number(row.count)]));
    const byTerminationReason = Object.fromEntries((this.database.prepare(`
      SELECT COALESCE(termination_reason, 'none') AS reason, COUNT(*) AS count
      FROM execution_epochs GROUP BY COALESCE(termination_reason, 'none') ORDER BY reason
    `).all() as Array<{ reason: string; count: number }>).map((row) => [row.reason, Number(row.count)]));
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(CASE WHEN state IN ('created','running','closing') THEN 1 ELSE 0 END), 0) AS active_count
      FROM execution_epochs
    `).get() as { count: number; active_count: number };
    return {
      epochCount: Number(totals.count),
      activeEpochCount: Number(totals.active_count),
      byState,
      byTerminationReason
    };
  }

  raiseProjectionDesired(taskId: string, seq: number, priority = 0, terminalTargetSeq?: number): ProjectionState {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO projection_states (
        task_id, committed_seq, desired_seq, generation, active_generation, priority,
        pending_since, terminal_target_seq, updated_at
      ) VALUES (?, 0, ?, 0, NULL, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        desired_seq = MAX(projection_states.desired_seq, excluded.desired_seq),
        priority = MAX(projection_states.priority, excluded.priority),
        pending_since = CASE
          WHEN projection_states.desired_seq <= projection_states.committed_seq
            AND excluded.desired_seq > projection_states.committed_seq
          THEN excluded.pending_since
          ELSE projection_states.pending_since
        END,
        terminal_target_seq = CASE
          WHEN excluded.terminal_target_seq IS NULL THEN projection_states.terminal_target_seq
          ELSE MAX(COALESCE(projection_states.terminal_target_seq, 0), excluded.terminal_target_seq)
        END,
        updated_at = excluded.updated_at
    `).run(
      taskId,
      Math.max(0, seq),
      Math.max(0, priority),
      updatedAt,
      terminalTargetSeq === undefined ? null : Math.max(0, terminalTargetSeq),
      updatedAt
    );
    return this.getProjectionState(taskId);
  }

  clearProjectionTerminalTarget(taskId: string, terminalTargetSeq: number): void {
    this.database.prepare(`
      UPDATE projection_states
      SET terminal_target_seq = CASE
        WHEN terminal_target_seq = ? THEN NULL
        ELSE terminal_target_seq
      END,
      updated_at = ?
      WHERE task_id = ?
    `).run(Math.max(0, terminalTargetSeq), new Date().toISOString(), taskId);
  }

  claimProjection(taskId: string): ProjectionClaim | undefined {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getProjectionState(taskId);
      if (state.activeGeneration !== undefined || state.desiredSeq <= state.committedSeq) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const generation = state.generation + 1;
      const result = this.database.prepare(`
        UPDATE projection_states
        SET generation = ?, active_generation = ?, priority = 0, updated_at = ?
        WHERE task_id = ? AND committed_seq = ? AND desired_seq = ? AND active_generation IS NULL
      `).run(
        generation,
        generation,
        new Date().toISOString(),
        taskId,
        state.committedSeq,
        state.desiredSeq
      );
      if (Number(result.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return undefined;
      }
      this.database.exec("COMMIT");
      return {
        taskId,
        fromSeq: state.committedSeq,
        toSeq: state.desiredSeq,
        generation
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseProjection(taskId: string, generation: number): void {
    this.database.prepare(`
      UPDATE projection_states
      SET active_generation = NULL, updated_at = ?
      WHERE task_id = ? AND active_generation = ?
    `).run(new Date().toISOString(), taskId, generation);
  }

  invalidateProjection(taskId: string): ProjectionState {
    this.database.prepare(`
      UPDATE projection_states
      SET generation = generation + 1, active_generation = NULL, updated_at = ?
      WHERE task_id = ?
    `).run(new Date().toISOString(), taskId);
    return this.getProjectionState(taskId);
  }

  getProjectionState(taskId: string): ProjectionState {
    const row = this.database.prepare(`
      SELECT * FROM projection_states WHERE task_id = ?
    `).get(taskId) as ProjectionRow | undefined;
    if (!row) {
      const updatedAt = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO projection_states (
          task_id, committed_seq, desired_seq, generation, active_generation, priority,
          pending_since, terminal_target_seq, updated_at
        ) VALUES (?, 0, 0, 0, NULL, 0, NULL, NULL, ?)
      `).run(taskId, updatedAt);
      return {
        taskId,
        committedSeq: 0,
        desiredSeq: 0,
        generation: 0,
        priority: 0,
        updatedAt
      };
    }
    return projectionRowToState(row);
  }

  listPendingProjectionTasks(): ProjectionState[] {
    const rows = this.database.prepare(`
      SELECT * FROM projection_states
      WHERE (desired_seq > committed_seq OR terminal_target_seq IS NOT NULL)
        AND active_generation IS NULL
      ORDER BY priority DESC, updated_at ASC
    `).all() as ProjectionRow[];
    return rows.map(projectionRowToState);
  }

  upsertExecutorSession(input: {
    taskId: string;
    sessionFile: string;
    workspaceKey?: string;
    resumeCount?: number;
  }): ExecutorSessionRecord {
    const updatedAt = new Date().toISOString();
    const workspaceKey = input.workspaceKey ?? input.taskId;
    this.database.prepare(`
      INSERT INTO executor_sessions (task_id, session_file, workspace_key, resume_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        session_file = excluded.session_file,
        workspace_key = excluded.workspace_key,
        resume_count = excluded.resume_count,
        updated_at = excluded.updated_at
    `).run(input.taskId, input.sessionFile, workspaceKey, input.resumeCount ?? 0, updatedAt);
    return {
      taskId: input.taskId,
      sessionFile: input.sessionFile,
      workspaceKey,
      resumeCount: input.resumeCount ?? 0,
      updatedAt
    };
  }

  transferExecutorSession(fromTaskId: string, toTaskId: string): ExecutorSessionRecord {
    const updatedAt = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE executor_sessions
      SET task_id = ?, updated_at = ?
      WHERE task_id = ?
        AND NOT EXISTS (SELECT 1 FROM executor_sessions WHERE task_id = ?)
    `).run(toTaskId, updatedAt, fromTaskId, toTaskId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Executor session transfer failed: ${fromTaskId} -> ${toTaskId}`);
    }
    const transferred = this.getExecutorSession(toTaskId);
    if (!transferred) {
      throw new Error(`Transferred Executor session is missing for ${toTaskId}`);
    }
    return transferred;
  }

  getExecutorSession(taskId: string): ExecutorSessionRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM executor_sessions WHERE task_id = ?
    `).get(taskId) as ExecutorSessionRow | undefined;
    return row ? executorSessionRowToRecord(row) : undefined;
  }

  deleteExecutorSession(taskId: string): void {
    this.database.prepare(`
      DELETE FROM executor_sessions WHERE task_id = ?
    `).run(taskId);
  }

  upsertTaskOutcome(outcome: TaskOutcome): TaskOutcome {
    this.database.prepare(`
      INSERT INTO task_outcomes (task_id, epoch_id, terminal_seq, outcome_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        epoch_id = excluded.epoch_id,
        terminal_seq = excluded.terminal_seq,
        outcome_json = excluded.outcome_json,
        created_at = excluded.created_at
    `).run(
      outcome.taskRef,
      outcome.epochRef,
      outcome.terminalSeq,
      JSON.stringify(outcome),
      outcome.createdAt
    );
    return outcome;
  }

  getTaskOutcome(taskId: string): TaskOutcome | undefined {
    const row = this.database.prepare(`
      SELECT * FROM task_outcomes WHERE task_id = ?
    `).get(taskId) as TaskOutcomeRow | undefined;
    return row ? taskOutcomeRowToRecord(row) : undefined;
  }

  listTaskOutcomes(limit = 32): TaskOutcome[] {
    const rows = this.database.prepare(`
      SELECT * FROM task_outcomes ORDER BY terminal_seq DESC LIMIT ?
    `).all(Math.max(1, Math.floor(limit))) as TaskOutcomeRow[];
    return rows.map(taskOutcomeRowToRecord);
  }

  upsertEpochOutcome(outcome: EpochOutcome): EpochOutcome {
    this.database.prepare(`
      INSERT INTO epoch_outcomes (epoch_id, task_id, terminal_seq, outcome_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(epoch_id) DO UPDATE SET
        task_id = excluded.task_id,
        terminal_seq = excluded.terminal_seq,
        outcome_json = excluded.outcome_json,
        created_at = excluded.created_at
    `).run(
      outcome.epochRef,
      outcome.taskRef,
      outcome.terminalSeq,
      JSON.stringify(outcome),
      outcome.createdAt
    );
    return outcome;
  }

  getEpochOutcome(epochId: string): EpochOutcome | undefined {
    const row = this.database.prepare(`
      SELECT * FROM epoch_outcomes WHERE epoch_id = ?
    `).get(epochId) as EpochOutcomeRow | undefined;
    return row ? epochOutcomeRowToRecord(row) : undefined;
  }

  listEpochOutcomes(limit = 32): EpochOutcome[] {
    const rows = this.database.prepare(`
      SELECT * FROM epoch_outcomes ORDER BY terminal_seq DESC LIMIT ?
    `).all(Math.max(1, Math.floor(limit))) as EpochOutcomeRow[];
    return rows.map(epochOutcomeRowToRecord);
  }

  epochRefsWithPrefix(prefix: string, limit = 4): string[] {
    const rows = this.database.prepare(`
      SELECT epoch_id FROM epoch_outcomes
      WHERE substr(epoch_id, 1, ?) = ?
      ORDER BY terminal_seq DESC LIMIT ?
    `).all(prefix.length, prefix, Math.max(1, Math.floor(limit))) as Array<{ epoch_id: string }>;
    return rows.map((row) => row.epoch_id);
  }

  listTaskEpochOutcomes(taskId: string, limit = 32): EpochOutcome[] {
    const rows = this.database.prepare(`
      SELECT * FROM epoch_outcomes WHERE task_id = ? ORDER BY terminal_seq DESC LIMIT ?
    `).all(taskId, Math.max(1, Math.floor(limit))) as EpochOutcomeRow[];
    return rows.map(epochOutcomeRowToRecord);
  }

  recordTaskTurn(input: { taskId: string; eventId: string }): number {
    this.database.prepare(`
      INSERT OR IGNORE INTO task_turn_events (event_id, task_id, created_at)
      VALUES (?, ?, ?)
    `).run(input.eventId, input.taskId, new Date().toISOString());
    return this.getTaskConsumedTurns(input.taskId);
  }

  getTaskConsumedTurns(taskId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM task_turn_events WHERE task_id = ?
    `).get(taskId) as { count: number };
    return Number(row.count);
  }

  getFofaQuota(taskId: string): { resultsConsumed: number; aggregationsConsumed: number } {
    const row = this.database.prepare(`
      SELECT results_consumed, aggregations_consumed
      FROM fofa_task_quotas
      WHERE task_id = ?
    `).get(taskId) as { results_consumed: number; aggregations_consumed: number } | undefined;
    return {
      resultsConsumed: Number(row?.results_consumed ?? 0),
      aggregationsConsumed: Number(row?.aggregations_consumed ?? 0)
    };
  }

  reserveFofaQuota(input: {
    taskId: string;
    kind: "results" | "aggregations";
    amount: number;
    limit: number;
  }): { consumed: number; remaining: number } {
    validateFofaQuotaInput(input.taskId, input.amount, input.limit);
    const column = input.kind === "results" ? "results_consumed" : "aggregations_consumed";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.ensureFofaQuotaRow(input.taskId);
      const row = this.database.prepare(`
        SELECT ${column} AS consumed FROM fofa_task_quotas WHERE task_id = ?
      `).get(input.taskId) as { consumed: number };
      const consumed = Number(row.consumed);
      if (consumed + input.amount > input.limit) {
        throw new FofaError(
          "fofa_quota_exhausted",
          `FOFA ${input.kind} quota exhausted for ${input.taskId}`
        );
      }
      const nextConsumed = consumed + input.amount;
      this.database.prepare(`
        UPDATE fofa_task_quotas SET ${column} = ?, updated_at = ? WHERE task_id = ?
      `).run(nextConsumed, new Date().toISOString(), input.taskId);
      this.database.exec("COMMIT");
      return { consumed: nextConsumed, remaining: input.limit - nextConsumed };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseFofaQuota(input: {
    taskId: string;
    kind: "results" | "aggregations";
    amount: number;
  }): { consumed: number } {
    validateFofaQuotaInput(input.taskId, input.amount);
    const column = input.kind === "results" ? "results_consumed" : "aggregations_consumed";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.ensureFofaQuotaRow(input.taskId);
      const row = this.database.prepare(`
        SELECT ${column} AS consumed FROM fofa_task_quotas WHERE task_id = ?
      `).get(input.taskId) as { consumed: number };
      const consumed = Math.max(0, Number(row.consumed) - input.amount);
      this.database.prepare(`
        UPDATE fofa_task_quotas SET ${column} = ?, updated_at = ? WHERE task_id = ?
      `).run(consumed, new Date().toISOString(), input.taskId);
      this.database.exec("COMMIT");
      return { consumed };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureFofaQuotaRow(taskId: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO fofa_task_quotas (
        task_id, results_consumed, aggregations_consumed, updated_at
      ) VALUES (?, 0, 0, ?)
    `).run(taskId, new Date().toISOString());
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_epochs (
        epoch_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        termination_reason TEXT,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        start_seq INTEGER,
        end_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_execution_epochs_task ON execution_epochs(task_id, attempt);
      CREATE INDEX IF NOT EXISTS idx_execution_epochs_state ON execution_epochs(state);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_epochs_active_task
        ON execution_epochs(task_id) WHERE state IN ('created', 'running', 'closing');
      CREATE TABLE IF NOT EXISTS projection_states (
        task_id TEXT PRIMARY KEY,
        committed_seq INTEGER NOT NULL DEFAULT 0,
        desired_seq INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        active_generation INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        pending_since TEXT,
        terminal_target_seq INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executor_sessions (
        task_id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        resume_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_outcomes (
        task_id TEXT PRIMARY KEY,
        epoch_id TEXT NOT NULL,
        terminal_seq INTEGER NOT NULL,
        outcome_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_outcomes_terminal_seq
        ON task_outcomes(terminal_seq DESC);
      CREATE TABLE IF NOT EXISTS epoch_outcomes (
        epoch_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        terminal_seq INTEGER NOT NULL,
        outcome_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_epoch_outcomes_task_terminal_seq
        ON epoch_outcomes(task_id, terminal_seq DESC);
      CREATE TABLE IF NOT EXISTS task_turn_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_turn_events_task
        ON task_turn_events(task_id);
      CREATE TABLE IF NOT EXISTS epoch_budgets (
        epoch_id TEXT PRIMARY KEY REFERENCES execution_epochs(epoch_id) ON DELETE CASCADE,
        time_limit_ms INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        paused_at INTEGER,
        accumulated_pause_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fofa_task_quotas (
        task_id TEXT PRIMARY KEY,
        results_consumed INTEGER NOT NULL DEFAULT 0 CHECK(results_consumed >= 0),
        aggregations_consumed INTEGER NOT NULL DEFAULT 0 CHECK(aggregations_consumed >= 0),
        updated_at TEXT NOT NULL
      );
    `);
    ensureColumn(this.database, "projection_states", "pending_since", "TEXT");
    ensureColumn(this.database, "projection_states", "terminal_target_seq", "INTEGER");
    ensureColumn(this.database, "executor_sessions", "workspace_key", "TEXT");
    this.database.exec("UPDATE executor_sessions SET workspace_key = task_id WHERE workspace_key IS NULL OR workspace_key = ''");
  }

  private recoverInterruptedEpochs(): void {
    const closedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE execution_epochs
      SET state = 'closed', termination_reason = 'shutdown', closed_at = ?,
          end_seq = COALESCE(end_seq, start_seq)
      WHERE state IN ('created', 'running', 'closing')
    `).run(closedAt);
  }

  private recoverInterruptedProjectionClaims(): number {
    const result = this.database.prepare(`
      UPDATE projection_states
      SET generation = generation + 1, active_generation = NULL, updated_at = ?
      WHERE active_generation IS NOT NULL
    `).run(new Date().toISOString());
    return Number(result.changes);
  }

}

function validateFofaQuotaInput(taskId: string, amount: number, limit?: number): void {
  if (!taskId.trim()) {
    throw new Error("FOFA quota taskId must not be empty");
  }
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("FOFA quota amount must be a non-negative integer");
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error("FOFA quota limit must be a non-negative integer");
  }
}

function ensureRuntimeMetadataTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function getOrCreateRunRefInDatabase(database: DatabaseSync): string {
  ensureRuntimeMetadataTable(database);
  const existing = database.prepare(`
    SELECT value FROM runtime_metadata WHERE key = 'run_ref'
  `).get() as { value: string } | undefined;
  if (existing?.value) {
    return existing.value;
  }
  const candidate = randomUUID();
  database.prepare(`
    INSERT OR IGNORE INTO runtime_metadata (key, value) VALUES ('run_ref', ?)
  `).run(candidate);
  const stored = database.prepare(`
    SELECT value FROM runtime_metadata WHERE key = 'run_ref'
  `).get() as { value: string } | undefined;
  if (!stored?.value) {
    throw new Error("Runtime run_ref was not persisted");
  }
  return stored.value;
}

function epochRowToRecord(row: EpochRow): ExecutionEpochRecord {
  return {
    epochId: row.epoch_id,
    taskId: row.task_id,
    attempt: Number(row.attempt),
    state: row.state,
    terminationReason: row.termination_reason ?? undefined,
    startedAt: row.started_at,
    closedAt: row.closed_at ?? undefined,
    startSeq: row.start_seq ?? undefined,
    endSeq: row.end_seq ?? undefined
  };
}

function projectionRowToState(row: ProjectionRow): ProjectionState {
  return {
    taskId: row.task_id,
    committedSeq: Number(row.committed_seq),
    desiredSeq: Number(row.desired_seq),
    generation: Number(row.generation),
    activeGeneration: row.active_generation ?? undefined,
    priority: Number(row.priority),
    pendingSince: row.pending_since ?? undefined,
    terminalTargetSeq: row.terminal_target_seq ?? undefined,
    updatedAt: row.updated_at
  };
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function executorSessionRowToRecord(row: ExecutorSessionRow): ExecutorSessionRecord {
  return {
    taskId: row.task_id,
    sessionFile: row.session_file,
    workspaceKey: row.workspace_key ?? row.task_id,
    resumeCount: Number(row.resume_count),
    updatedAt: row.updated_at
  };
}

function taskOutcomeRowToRecord(row: TaskOutcomeRow): TaskOutcome {
  const parsed = JSON.parse(row.outcome_json) as TaskOutcome;
  return {
    ...parsed,
    taskRef: row.task_id,
    epochRef: row.epoch_id,
    terminalSeq: Number(row.terminal_seq),
    createdAt: row.created_at
  };
}

function epochOutcomeRowToRecord(row: EpochOutcomeRow): EpochOutcome {
  const parsed = JSON.parse(row.outcome_json) as EpochOutcome;
  return {
    ...parsed,
    epochRef: row.epoch_id,
    taskRef: row.task_id,
    terminalSeq: Number(row.terminal_seq),
    createdAt: row.created_at
  };
}
