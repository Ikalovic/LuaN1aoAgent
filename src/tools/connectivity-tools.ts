import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RouteOpenInput, RouteStatus } from "../connectivity/route-manager.js";

export type ExecutorConnectivityRuntime = {
  openRoute(input: RouteOpenInput, ownerTaskId: string): Promise<RouteStatus>;
  routeStatus(routeRef?: string): Promise<RouteStatus[]>;
  stopRoute(routeRef: string): Promise<RouteStatus>;
  reconnectRoute(routeRef: string): Promise<RouteStatus>;
};

export function createExecutorConnectivityTools(
  runtime: ExecutorConnectivityRuntime,
  ownerTaskId: string
): ToolDefinition<any, any, any>[] {
  return [
    defineTool({
      name: "route_open",
      label: "Open Network Route",
      description: "Create a Runtime-managed SSH or Chisel route through a real pivot host. The process-wide transparent proxy is configured by the operator before Agent execution and cannot be created or replaced with this tool. For SSH, credentialRef must reference a sensitive Artifact whose content is exactly the password or private key; keep descriptive credential evidence in a separate Artifact. Use an existing Host ref when available; otherwise use the real pivot IP or hostname. The Runtime keeps connector addresses private and returns stable route/connection references.",
      parameters: Type.Object({
        connector: Type.Union([Type.Literal("ssh"), Type.Literal("chisel")]),
        pivotHostRef: Type.String({ minLength: 1, maxLength: 256 }),
        dialAddress: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        targetCidrs: Type.Array(Type.String({ minLength: 3, maxLength: 64 }), { minItems: 1, maxItems: 32 }),
        credentialRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        bootstrapConnectionRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        options: Type.Optional(Type.Object({
          port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
          user: Type.Optional(Type.String({ minLength: 1, maxLength: 128 }))
        }, { additionalProperties: false }))
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => routeToolResult(
        await runtime.openRoute(params as RouteOpenInput, ownerTaskId)
      )
    }),
    defineTool({
      name: "route_status",
      label: "Inspect Network Routes",
      description: "Inspect one Runtime-managed route or list all routes available to this run.",
      parameters: Type.Object({
        routeRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => routeToolResult(
        await runtime.routeStatus(params.routeRef)
      )
    }),
    defineTool({
      name: "route_stop",
      label: "Stop Network Route",
      description: "Stop a Runtime-managed route while preserving its stable reference for later reconnection.",
      parameters: Type.Object({
        routeRef: Type.String({ minLength: 1, maxLength: 256 })
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => routeToolResult(
        await runtime.stopRoute(params.routeRef)
      )
    }),
    defineTool({
      name: "route_reconnect",
      label: "Reconnect Network Route",
      description: "Restore a stopped or stale Runtime-managed route in place using its existing reference.",
      parameters: Type.Object({
        routeRef: Type.String({ minLength: 1, maxLength: 256 })
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => routeToolResult(
        await runtime.reconnectRoute(params.routeRef)
      )
    })
  ];
}

function routeToolResult(details: RouteStatus | RouteStatus[]) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details
  };
}
