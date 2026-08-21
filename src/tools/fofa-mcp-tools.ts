import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FOFA_FIELDS, type FofaRecord, type FofaToolName } from "../fofa/fofa-types.js";
import type { FofaMcpCallResult, FofaMcpRuntime } from "../mcp/fofa-runtime.js";
import type { ArtifactStore } from "../stores/artifact-store.js";

const MAX_MODEL_BYTES = 12_000;
const fieldSchema = Type.Union(FOFA_FIELDS.map((field) => Type.Literal(field)));
const fieldsSchema = Type.Array(fieldSchema, { minItems: 1, maxItems: FOFA_FIELDS.length });

export function createExecutorFofaTools(
  runtime: Pick<FofaMcpRuntime, "call">,
  artifactStore: ArtifactStore,
  taskRef: string
): ToolDefinition<any, any, any>[] {
  const execute = async (
    toolName: FofaToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => presentResult(await runtime.call(taskRef, toolName, args, signal), artifactStore, taskRef);

  return [
    defineTool({
      name: "fofa_account_info",
      label: "FOFA Account Info",
      description: "Read a redacted FOFA capability and points summary. No account credentials are exposed.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_callId, _params, signal) => execute("fofa_account_info", {}, signal)
    }),
    defineTool({
      name: "fofa_search",
      label: "FOFA Search",
      description: "Search FOFA for authorized Scope assets. Every OR branch must retain a positive authorized anchor. Associated旁站 are candidate-only and cannot be actively tested.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 4_096 }),
        fields: fieldsSchema,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        full: Type.Optional(Type.Boolean())
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("fofa_search", {
        ...params,
        limit: params.limit ?? 100,
        full: params.full ?? false
      }, signal)
    }),
    defineTool({
      name: "fofa_search_next",
      label: "FOFA Search Next",
      description: "Continue a previous FOFA search with its opaque Runtime cursor.",
      parameters: Type.Object({
        cursor: Type.String({ minLength: 1, maxLength: 256 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("fofa_search_next", {
        cursor: params.cursor,
        limit: params.limit ?? 100
      }, signal)
    }),
    defineTool({
      name: "fofa_stats",
      label: "FOFA Statistics",
      description: "Aggregate FOFA statistics for a query anchored to authorized Scope.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 4_096 }),
        fields: fieldsSchema,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("fofa_stats", {
        ...params,
        limit: params.limit ?? 100
      }, signal)
    }),
    defineTool({
      name: "fofa_host_aggregate",
      label: "FOFA Host Aggregate",
      description: "Inspect FOFA aggregation for an authorized host or a trusted derived asset reference.",
      parameters: Type.Object({
        host: Type.String({ minLength: 1, maxLength: 2_048 }),
        detail: Type.Optional(Type.Boolean())
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("fofa_host_aggregate", {
        host: params.host,
        detail: params.detail ?? false
      }, signal)
    })
  ];
}

async function presentResult(
  result: FofaMcpCallResult,
  artifactStore: ArtifactStore,
  taskRef: string
) {
  const artifactPayload = {
    ...result.full,
    cursor: result.cursor,
    quota: result.quota
  };
  const artifact = await artifactStore.write({
    taskId: taskRef,
    kind: "json",
    mediaType: "application/vnd.luanniao.fofa+json",
    extension: "json",
    data: JSON.stringify(artifactPayload, null, 2)
  });
  const records = result.full.records ?? [];
  const inScopePreview = records.filter((record) => record.classification === "in_scope").slice(0, 25);
  const candidatePreview = records.filter((record) => record.classification === "candidate_only").slice(0, 10);
  const summary: Record<string, unknown> = {
    operation: result.operation,
    query: result.full.query,
    fields: result.full.fields,
    returned: result.full.returned,
    total: result.full.total,
    consumedFpoints: result.full.consumedFpoints,
    classificationCounts: {
      in_scope: records.filter((record) => record.classification === "in_scope").length,
      candidate_only: records.filter((record) => record.classification === "candidate_only").length
    },
    quota: result.quota,
    cursor: result.cursor,
    artifactRef: artifact.artifactRef,
    inScopePreview,
    candidatePreview,
    candidatePolicy: { classification: "candidate_only", active_testing_allowed: false },
    warning: "candidate_only records are discovery leads; active_testing_allowed:false and they do not expand Scope"
  };
  if (result.full.data !== undefined) {
    summary.dataPreview = boundedDataPreview(result.full.data);
  }
  boundPreview(summary, inScopePreview, candidatePreview);
  const text = JSON.stringify(summary, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: summary
  };
}

function boundPreview(
  summary: Record<string, unknown>,
  inScopePreview: FofaRecord[],
  candidatePreview: FofaRecord[]
): void {
  while (Buffer.byteLength(JSON.stringify(summary, null, 2), "utf8") > MAX_MODEL_BYTES) {
    if (candidatePreview.length > 0) {
      candidatePreview.pop();
    } else if (inScopePreview.length > 0) {
      inScopePreview.pop();
    } else if (summary.dataPreview !== undefined) {
      delete summary.dataPreview;
    } else {
      throw new Error("FOFA model summary exceeded its fixed byte budget");
    }
  }
}

function boundedDataPreview(data: Record<string, unknown>): string {
  const encoded = JSON.stringify(data);
  return encoded.length <= 2_000 ? encoded : `${encoded.slice(0, 2_000)}…`;
}
