import { describe, expect, it } from "vitest";
import { createLayoutRunner, layoutStructureKey } from "./graphLayout";
import type { GraphNode } from "./types";
const node: GraphNode = { id: "host", graphKind: "operation", type: "Host", label: "host", properties: {}, evidenceRefs: [] };
describe("owned ELK lifecycle", () => {
  it("ignores a layout that resolves after its abort", async () => {
    let resolve!: (value: any) => void;
    const run = createLayoutRunner({ layout: () => new Promise((done) => { resolve = done; }) });
    const controller = new AbortController();
    const pending = run([node], [], "operation", controller.signal);
    controller.abort();
    resolve({ children: [{ id: "host", x: 10, y: 20, width: 172, height: 68 }] });
    expect(await pending).toBeUndefined();
  });
  it("keys structure independently of changing labels and timestamps", () => {
    expect(layoutStructureKey([node], [], "operation")).toBe(layoutStructureKey([{ ...node, label: "new", updatedAt: "today" }], [], "operation"));
  });
  it("isolates position caches between runtimes with identical IDs", async () => {
    let calls = 0;
    const run = createLayoutRunner({ layout: async (graph) => { calls++; return graph; } });
    await run([node], [], "operation", undefined, "runtime-a");
    await run([node], [], "operation", undefined, "runtime-b");
    expect(calls).toBe(2);
  });
});
