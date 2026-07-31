import type {
  PlannerCommand,
  PlannerDecision,
  PlannerTaskPatch,
  PlannerTaskSpec,
  TaskGraphStatus
} from "./types.js";

export class PlannerProtocolError extends Error {}

const ARTIFACT_REF_PATTERN = /artifact:[A-Za-z0-9][A-Za-z0-9._-]*/g;

export function normalizePlannerDecision(value: unknown): PlannerDecision {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("Planner output must be a JSON object");
  }
  const reason = nonEmptyString(value.reason) ?? fail("Planner reason is required");
  if (value.commands !== undefined && !Array.isArray(value.commands)) {
    throw new PlannerProtocolError("Planner commands must be an array");
  }
  return {
    commands: (value.commands ?? []).map(normalizePlannerCommand),
    reason
  };
}

/**
 * Verifies every artifact:* Ref in the decision against the ArtifactStore.
 * Unambiguous abbreviations (exactly one artifact carries the prefix) are
 * resolved to their full Ref in the returned decision — models habitually
 * truncate UUIDs, and bouncing a deterministically fixable Ref back to the
 * model only burns a Planner cycle. Unknown or ambiguous Refs still reject.
 */
export async function validatePlannerArtifactRefs(
  decision: PlannerDecision,
  listArtifacts: () => Promise<Array<{ artifactRef: string }>>
): Promise<PlannerDecision> {
  const referenced = artifactRefsFromValue(decision);
  if (referenced.length === 0) return decision;
  const artifacts = await listArtifacts();
  const realRefs = new Set(artifacts.map((artifact) => artifact.artifactRef));
  const resolutions = new Map<string, string>();
  const problems: string[] = [];
  for (const artifactRef of referenced) {
    if (realRefs.has(artifactRef)) continue;
    const matches = artifacts
      .map((artifact) => artifact.artifactRef)
      .filter((candidate) => candidate.startsWith(artifactRef));
    if (matches.length === 1) {
      resolutions.set(artifactRef, matches[0]);
      continue;
    }
    problems.push(
      matches.length > 1
        ? `${artifactRef} (ambiguous, candidates: ${matches.slice(0, 3).join(", ")})`
        : artifactRef
    );
  }
  if (problems.length > 0) {
    throw new PlannerProtocolError(
      `Planner command contains unknown or ambiguous Artifact Ref(s): ${problems.join(", ")}. Use exact full Refs from Planner input.`
    );
  }
  if (resolutions.size === 0) return decision;
  return rewriteArtifactRefs(decision, resolutions);
}

function rewriteArtifactRefs<T>(value: T, resolutions: ReadonlyMap<string, string>): T {
  if (typeof value === "string") {
    let rewritten: string = value;
    for (const [abbreviated, full] of resolutions) {
      rewritten = rewritten.replace(
        new RegExp(`${escapeRegExp(abbreviated)}(?![A-Za-z0-9._-])`, "g"),
        full
      );
    }
    return rewritten as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteArtifactRefs(entry, resolutions)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteArtifactRefs(entry, resolutions)])
    ) as T;
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePlannerCommand(value: unknown): PlannerCommand {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("Planner command must be an object");
  }
  const basedOnRefs = stringArray(value.basedOnRefs);
  switch (value.kind) {
    case "create_tasks": {
      if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
        throw new PlannerProtocolError("create_tasks requires at least one task");
      }
      return {
        kind: "create_tasks",
        tasks: value.tasks.map(normalizePlannerTaskSpec),
        basedOnRefs
      };
    }
    case "patch_task":
      return {
        kind: "patch_task",
        taskId: requireTaskId(value.taskId),
        patch: normalizePlannerTaskPatch(value.patch),
        basedOnRefs
      };
    case "replace_dependencies":
      return {
        kind: "replace_dependencies",
        taskId: requireTaskId(value.taskId),
        dependencyTaskIds: stringArray(value.dependencyTaskIds).map(requireTaskId),
        basedOnRefs
      };
    case "set_task_status":
      return {
        kind: "set_task_status",
        taskId: requireTaskId(value.taskId),
        status: requireTaskStatus(value.status),
        basedOnRefs
      };
    case "set_node_status":
      return {
        kind: "set_node_status",
        nodeId: requireNodeId(value.nodeId),
        status: nonEmptyString(value.status) ?? fail("set_node_status requires status"),
        basedOnRefs
      };
    default:
      throw new PlannerProtocolError(`Unsupported planner command: ${String(value.kind)}`);
  }
}

function normalizePlannerTaskSpec(value: unknown): PlannerTaskSpec {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("Task specification must be an object");
  }
  return {
    id: requireTaskId(value.id),
    goal: nonEmptyString(value.goal) ?? fail("Task goal is required"),
    targetRefs: nonEmptyStringArray(value.targetRefs, ["goal:root"]),
    scopeRef: nonEmptyString(value.scopeRef) ?? "scope:root",
    successCriteria: nonEmptyStringArray(value.successCriteria, ["产出可由 Observer 投影的 evidence candidate"]),
    budget: isRecord(value.budget) ? value.budget : undefined,
    priority: typeof value.priority === "number" && Number.isFinite(value.priority) ? value.priority : 1,
    parentTaskId: nonEmptyString(value.parentTaskId),
    dependsOnTaskRefs: stringArray(value.dependsOnTaskRefs).map(requireTaskId),
    parallelGroup: nonEmptyString(value.parallelGroup)
  };
}

function normalizePlannerTaskPatch(value: unknown): PlannerTaskPatch {
  if (!isRecord(value)) {
    throw new PlannerProtocolError("patch_task requires a patch object");
  }
  const patch: PlannerTaskPatch = {};
  if (isRecord(value.budget)) patch.budget = value.budget;
  if (typeof value.priority === "number" && Number.isFinite(value.priority)) patch.priority = value.priority;
  if (typeof value.parallelGroup === "string") patch.parallelGroup = value.parallelGroup;
  if (Object.keys(patch).length === 0) {
    throw new PlannerProtocolError("patch_task patch contains no supported fields");
  }
  return patch;
}

function requireTaskId(value: unknown): string {
  const taskId = nonEmptyString(value);
  if (!taskId?.startsWith("task:")) {
    throw new PlannerProtocolError(`Invalid task id: ${String(value)}`);
  }
  return taskId;
}

function requireNodeId(value: unknown): string {
  return nonEmptyString(value) ?? fail("Node id is required");
}

function requireTaskStatus(value: unknown): TaskGraphStatus {
  if (["open", "completed", "blocked", "failed", "archived"].includes(String(value))) {
    return value as TaskGraphStatus;
  }
  throw new PlannerProtocolError(`Invalid task status: ${String(value)}`);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function nonEmptyStringArray(value: unknown, fallback: string[]): string[] {
  const values = stringArray(value);
  return values.length > 0 ? values : fallback;
}

function artifactRefsFromValue(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      refs.push(...(candidate.match(ARTIFACT_REF_PATTERN) ?? []));
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (isRecord(candidate)) {
      Object.values(candidate).forEach(visit);
    }
  };
  visit(value);
  return [...new Set(refs)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new PlannerProtocolError(message);
}
