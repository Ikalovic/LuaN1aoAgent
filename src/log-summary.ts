import type { ExecutionEvent, JsonObject } from "./types.js";
import { buildProjectionObservations, type ProjectionObservation } from "./projection.js";

export function compactExecutionEvents(events: ExecutionEvent[]): Array<Record<string, unknown>> {
  return events.map(compactExecutionEvent);
}

export function compactExecutionEvent(event: ExecutionEvent): Record<string, unknown> {
  return {
    id: event.id,
    taskId: event.taskId,
    role: event.role,
    eventType: event.eventType,
    timestamp: event.timestamp,
    summary: event.summary,
    artifactRefs: event.artifactRefs,
    payload: compactJson(event.payload, 0)
  };
}

export function compactJson(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > 900 ? `${value.slice(0, 900)}...[truncated:${value.length}]` : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compactJson(item, depth + 1));
  }
  if (depth > 4) {
    return "[truncated:depth]";
  }
  const compacted: JsonObject = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    if (["thinking", "thinkingSignature", "messages"].includes(key)) {
      continue;
    }
    compacted[key] = compactJson(propertyValue, depth + 1);
  }
  return compacted;
}

export type SupervisorTraceSummary = {
  actionTraceText: string;
  loopSignalsText: string;
};

export function summarizeSupervisorTrace(events: ExecutionEvent[]): SupervisorTraceSummary {
  const fallbackTraceLines: string[] = [];
  const actionKeys: string[] = [];
  let localWorkspaceDrift = false;
  let artifactOnlyResultCount = 0;

  for (const event of events) {
    const payload = event.payload;
    fallbackTraceLines.push(`${fallbackTraceLines.length + 1}. ${serializeSupervisorEvent(event)}`);
    const actionKey = actionFingerprint(event, payload);
    if (actionKey) {
      actionKeys.push(actionKey);
    }
    if (detectLocalWorkspaceDrift(event, payload)) {
      localWorkspaceDrift = true;
    }
    if (resultText(payload).includes("artifactRef")) {
      artifactOnlyResultCount += 1;
    }
  }

  const repeatedAction = mostRepeated(actionKeys);
  const causalObservations = buildProjectionObservations(events).slice(-8);
  const visibleTraceLines = causalObservations.length > 0
    ? causalObservations.map((observation, index) => `${index + 1}. ${summarizeCausalObservation(observation)}`)
    : fallbackTraceLines.slice(-16);
  const loopSignals = [
    repeatedAction.count >= 2 ? `重复完全相同动作：${repeatedAction.key} ×${repeatedAction.count}` : "重复完全相同动作：未明显出现",
    `本地工作区漂移：${localWorkspaceDrift ? "是" : "否"}`,
    `大输出/Artifact 指针结果：${artifactOnlyResultCount} 条`
  ];

  return {
    actionTraceText: visibleTraceLines.length > 0
      ? visibleTraceLines.join("\n")
      : "暂无可监督的近期执行轨迹。",
    loopSignalsText: loopSignals.join("\n")
  };
}

function summarizeCausalObservation(observation: ProjectionObservation): string {
  return JSON.stringify({
    seqStart: observation.seqStart,
    seqEnd: observation.seqEnd,
    status: observation.status,
    intent: observation.intent,
    action: observation.action,
    input: observation.inputDigest,
    outcome: observation.outcomeDigest,
    materialIntegrity: observation.materialIntegrity,
    executorCommentary: observation.executorCommentary,
    actions: observation.actions,
    artifactRefs: observation.artifactRefs,
    evidenceRefs: observation.sourceEventIds
  });
}

function serializeSupervisorEvent(event: ExecutionEvent): string {
  return JSON.stringify({
    seq: event.seq,
    id: event.id,
    eventType: event.eventType,
    summary: event.summary,
    payload: event.payload,
    artifactRefs: event.artifactRefs
  });
}

function extractContentText(content: unknown[]): string {
  return content
    .filter(isRecord)
    .map((item) => {
      if (typeof item.text === "string") {
        return item.text;
      }
      if (isRecord(item.text)) {
        return JSON.stringify(item.text);
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function actionFingerprint(event: ExecutionEvent, payload: JsonObject): string | undefined {
  if (!["tool_started", "tool_execution_start"].includes(event.eventType)) {
    return undefined;
  }
  const toolName = stringValue(payload.toolName, "");
  const args = isRecord(payload.args) ? payload.args : undefined;
  if (!toolName) {
    return undefined;
  }
  return `${toolName}:${JSON.stringify(args ?? {})}`;
}

function detectLocalWorkspaceDrift(event: ExecutionEvent, payload: JsonObject): boolean {
  const text = `${event.summary ?? ""} ${JSON.stringify(payload)} ${resultText(payload)}`.toLowerCase();
  return text.includes(".agent-runtime") || text.includes("node_modules") || text.includes("package.json") || text.includes("tsconfig.json");
}

function resultText(payload: JsonObject): string {
  if (!isRecord(payload.result)) {
    return "";
  }
  const content = Array.isArray(payload.result.content) ? payload.result.content : [];
  return extractContentText(content);
}

function mostRepeated(values: string[]): { key: string; count: number } {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = { key: "", count: 0 };
  for (const [key, count] of counts) {
    if (count > best.count) {
      best = { key, count };
    }
  }
  return best;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
