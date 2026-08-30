import assert from "node:assert/strict";
import test from "node:test";
import { createNetworkDiagnosticsTools, type NetworkDiagnosticsRuntime } from "../src/tools/network-diagnostics-tools.js";

test("network diagnostics expose structured health and controlled ICMP", async () => {
  const calls: string[] = [];
  const runtime: NetworkDiagnosticsRuntime = {
    networkStatus: async (taskId) => {
      calls.push(`status:${taskId}`);
      return { status: "healthy", tcpDataPlane: true, broker: true, icmp: "supported", checkedAt: "now" };
    },
    icmpEcho: async (taskId, target, timeoutMs) => {
      calls.push(`icmp:${taskId}:${target}:${timeoutMs}`);
      return { status: "reply", target, address: "192.0.2.1", roundTripMs: 4.2 };
    }
  };
  const [status, icmp] = createNetworkDiagnosticsTools(runtime, "task:test");
  const statusResult = await status!.execute("call:status", {}, new AbortController().signal, () => undefined, {} as never);
  const icmpResult = await icmp!.execute("call:icmp", { target: "example.test", timeoutMs: 750 }, new AbortController().signal, () => undefined, {} as never);

  assert.deepEqual(calls, ["status:task:test", "icmp:task:test:example.test:750"]);
  assert.equal(statusResult.details.status, "healthy");
  assert.equal(icmpResult.details.status, "reply");
  assert.match(icmp!.description, /does not prove.*down/i);
  assert.match(icmp!.description, /SOCKS5.*unsupported/i);
});
