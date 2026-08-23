import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BeekeeperToolName } from "../beekeeper/beekeeper-types.js";
import type { BeekeeperMcpRuntime } from "../mcp/beekeeper-runtime.js";

export function createExecutorBeekeeperTools(
  runtime: Pick<BeekeeperMcpRuntime, "call">,
  taskRef: string
) {
  const execute = async (
    toolName: BeekeeperToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => presentResult(await runtime.call(taskRef, toolName, args, signal));

  return [
    defineTool({
      name: "query_credentials",
      label: "Query Credentials",
      description: "Query plaintext Beekeeper credentials. Domain is optional and unrestricted. Use small pages; stop after one credential validates instead of fetching everything.",
      parameters: Type.Object({
        domain: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        include_invalid: Type.Optional(Type.Boolean())
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("query_credentials", {
        domain: params.domain,
        cursor: params.cursor,
        include_invalid: params.include_invalid ?? false,
        limit: params.limit ?? 50
      }, signal)
    }),
    defineTool({
      name: "store_credential",
      label: "Store Credential",
      description: "Store one plaintext credential in Beekeeper. New credentials default to valid=true.",
      parameters: Type.Object({
        domain: Type.String({ minLength: 1, maxLength: 255 }),
        account: Type.String({ minLength: 1, maxLength: 512 }),
        password: Type.String({ minLength: 1, maxLength: 1024 }),
        source: Type.Optional(Type.String({ maxLength: 255 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("store_credential", {
        domain: params.domain,
        account: params.account,
        password: params.password,
        source: params.source ?? ""
      }, signal)
    }),
    defineTool({
      name: "mark_credential_invalid",
      label: "Mark Credential Invalid",
      description: "Mark a credential invalid only after explicit authentication rejection. Do not use for timeout, WAF, network error, CAPTCHA, rate limit, or inconclusive login attempts.",
      parameters: Type.Object({
        credential_id: Type.Integer({ minimum: 1 }),
        reason: Type.Optional(Type.String({ maxLength: 512 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("mark_credential_invalid", {
        credential_id: params.credential_id,
        reason: params.reason
      }, signal)
    })
  ];
}

function presentResult(result: unknown) {
  const text = JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: result
  };
}
