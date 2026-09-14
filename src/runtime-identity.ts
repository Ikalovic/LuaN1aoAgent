import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StoredRunIdentity = {
  userGoal?: string;
  scopeSummary?: string;
  taskType?: "ctf" | "pentest";
  rootGoalStatus?: string;
  runRef?: string;
};

/**
 * Reads the durable run identity stored in one runtime directory:
 * Root Goal, authorized scope, task type and the previous Root Goal status.
 * Shared by the CLI resume path and the Web continuation path.
 */
export function readStoredRunIdentity(runtimeDir: string): StoredRunIdentity {
  const databasePath = join(runtimeDir, "state.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(`Cannot resume ${runtimeDir}: state.sqlite does not exist`);
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rootGoal = tryGet(database, `
      SELECT label, properties_json FROM nodes WHERE id = 'goal:root'
    `) as { label?: string; properties_json?: string } | undefined;
    const rootScope = tryGet(database, `
      SELECT properties_json FROM nodes WHERE id = 'scope:root'
    `) as { properties_json?: string } | undefined;
    const goalProperties = parseJsonObject(rootGoal?.properties_json);
    const scopeProperties = parseJsonObject(rootScope?.properties_json);
    const latestRun = tryGet(database, `
      SELECT payload_json FROM execution_events
      WHERE event_type = 'run_started' ORDER BY seq DESC LIMIT 1
    `) as { payload_json?: string } | undefined;
    const runRef = tryGet(database, `
      SELECT value FROM runtime_metadata WHERE key = 'run_ref'
    `) as { value?: string } | undefined;
    const payload = parseJsonObject(latestRun?.payload_json);
    const storedTaskType = payload?.taskType === "ctf"
      ? "ctf"
      : payload?.taskType === "pentest"
        ? "pentest"
        : undefined;
    return {
      userGoal: rootGoal?.label ?? stringValue(payload?.userGoal),
      scopeSummary: stringValue(scopeProperties?.summary) ?? stringValue(payload?.scopeSummary),
      taskType: storedTaskType,
      rootGoalStatus: stringValue(goalProperties?.status),
      runRef: stringValue(runRef?.value)
    };
  } finally {
    database.close();
  }
}

function tryGet(database: DatabaseSync, sql: string): unknown {
  try {
    return database.prepare(sql).get();
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
