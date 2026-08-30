import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { IcmpEchoResult, TaskNetworkHealth } from "../connectivity/network-sandbox-manager.js";

export type NetworkDiagnosticsRuntime = {
  networkStatus(taskId: string): Promise<TaskNetworkHealth>;
  icmpEcho(taskId: string, target: string, timeoutMs: number): Promise<IcmpEchoResult>;
};

export function createNetworkDiagnosticsTools(
  runtime: NetworkDiagnosticsRuntime,
  taskId: string
): ToolDefinition<any, any, any>[] {
  return [
    defineTool({
      name: "network_status",
      label: "Inspect Task Network Health",
      description: "Return Runtime-verified Gateway, TCP data-plane, broker, and ICMP capability status. Use this instead of probing an out-of-scope public control host.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => toolResult(await runtime.networkStatus(taskId))
    }),
    defineTool({
      name: "icmp_echo",
      label: "Controlled ICMP Echo",
      description: "Send exactly one scope-controlled IPv4 ICMP Echo from Gateway. ICMP silence does not prove the host is down. ICMP through a matching SOCKS5 route is unsupported and is never bypassed.",
      parameters: Type.Object({
        target: Type.String({ minLength: 1, maxLength: 253 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 3_000 }))
      }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => toolResult(
        await runtime.icmpEcho(taskId, params.target, params.timeoutMs ?? 1_000)
      )
    })
  ];
}

function toolResult<T>(details: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details
  };
}
