import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSituation } from "../situation";
import type { RuntimeState, GraphNode } from "../types";
import { FindingsView } from "./FindingsView";
const nodes: GraphNode[] = [
  { id: "v", type: "Vulnerability", graphKind: "reasoning", label: "Missing proof", properties: {}, evidenceRefs: [] },
  { id: "h", type: "Hypothesis", graphKind: "reasoning", label: "Open question", properties: { status: "open" }, evidenceRefs: [] },
  { id: "host", type: "Host", graphKind: "operation", label: "Linked host", properties: {}, evidenceRefs: [] }
];
const situation = buildSituation({ graph: { nodes, edges: [{ from: "v", to: "host", type: "affects", properties: {}, evidenceRefs: [] }], source: "sqlite" } } as unknown as RuntimeState);
describe("findings selection and evidence", () => {
  it("shows only actual validation failures when missing evidence is selected", () => {
    render(<FindingsView situation={situation} onSelect={vi.fn()} onGraph={vi.fn()} onTypeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "缺少证据" }));
    expect(screen.getByText("Missing proof")).toBeInTheDocument();
    expect(screen.queryByText("Open question")).not.toBeInTheDocument();
    expect(screen.getByText("Linked host")).toBeInTheDocument();
  });
  it("preserves node identity when selecting a filtered finding", () => {
    const select = vi.fn();
    render(<FindingsView situation={situation} type="Hypothesis" onSelect={select} onGraph={vi.fn()} onTypeChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open question" }));
    expect(select).toHaveBeenCalledWith("h");
    expect(screen.queryByText("Missing proof")).not.toBeInTheDocument();
  });
});
