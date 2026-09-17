import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../language";
import type { GraphEdge, GraphNode } from "../types";

// cytoscape needs a real layout engine and canvas, neither of which jsdom
// provides. The graph branch is asserted through the props this component hands
// down, so the renderer itself is stubbed.
const graphSpy = vi.fn();
vi.mock("./GraphView", () => ({
  GraphView: (props: { nodes: GraphNode[]; edges: GraphEdge[] }) => {
    graphSpy(props);
    return <div data-testid="graph-stub" />;
  }
}));

const { MemoryView } = await import("./MemoryView");

// jsdom reports an en-US navigator, so without a stored preference the UI would
// render English and every Chinese query below would miss.
beforeEach(() => {
  localStorage.setItem("luanniao-locale", "zh-CN");
});

afterEach(() => {
  cleanup();
  graphSpy.mockClear();
});

function osintNode(id: string, type: string, label: string, properties: Record<string, unknown>): GraphNode {
  return {
    id,
    graphKind: "operation",
    type,
    label,
    properties: { origin: "osint", source: "osint", ...properties },
    evidenceRefs: ["event:1"]
  };
}

function renderView(nodes: GraphNode[], edges: GraphEdge[] = []) {
  return render(
    <LanguageProvider>
      <MemoryView runtimeDir="/tmp/run" nodes={nodes} edges={edges} onSelectNode={vi.fn()} />
    </LanguageProvider>
  );
}

describe("MemoryView", () => {
  it("explains an empty memory instead of rendering an empty graph", () => {
    renderView([]);
    expect(screen.getByText(/还没有图记忆/)).toBeInTheDocument();
    expect(screen.queryByTestId("graph-stub")).toBeNull();
  });

  it("shows only nodes the collection projection stamped as memory", async () => {
    render(
      <LanguageProvider>
        <MemoryView
          runtimeDir="/tmp/run"
          nodes={[
            osintNode("op:org", "Organization", "某某科技有限公司", { confidence: "observed" }),
            osintNode("op:host", "Host", "example.com", { confidence: "observed" }),
            // A target-side node the runtime observed itself: no origin stamp, so
            // it is not memory and must not appear here.
            { id: "op:observed", graphKind: "operation", type: "WebEndpoint", label: "/login", properties: {}, evidenceRefs: [] }
          ]}
          edges={[]}
          onSelectNode={vi.fn()}
        />
      </LanguageProvider>
    );

    // GraphView is lazily imported, so the stub appears a tick later.
    expect(await screen.findByTestId("graph-stub")).toBeInTheDocument();
    const passed = graphSpy.mock.calls.at(-1)?.[0] as { nodes: GraphNode[] };
    expect(passed.nodes.map((node) => node.id).sort()).toEqual(["op:host", "op:org"]);
  });

  it("derives source tags and confidence from node properties", () => {
    renderView([
      osintNode("op:org", "Organization", "甲公司", {
        confidence: "inferred",
        provenance: [{ url: "https://a.example/1", source: "sogou" }, { url: "https://b.example/2", source: "so360" }]
      })
    ]);

    fireEvent.click(screen.getByText("清单"));

    const table = document.querySelector(".ant-table");
    expect(table).not.toBeNull();
    // "推断" also labels the summary statistic, so the row assertion is scoped
    // to the table rather than the whole view.
    expect(within(table as HTMLElement).getByText("甲公司")).toBeInTheDocument();
    expect(within(table as HTMLElement).getByText("推断")).toBeInTheDocument();
    expect(within(table as HTMLElement).getByText("sogou")).toBeInTheDocument();
    expect(within(table as HTMLElement).getByText("so360")).toBeInTheDocument();
  });

  it("flags out-of-scope leads, masked values and imported nodes distinctly", () => {
    renderView([
      osintNode("op:lead", "Host", "elsewhere.example", {
        classification: "candidate_only",
        active_testing_allowed: false,
        validationStatus: "pending"
      }),
      osintNode("op:person", "Person", "张*", { masked: true, personalData: true }),
      { ...osintNode("op:imported", "Organization", "乙公司", {}), properties: { origin: "imported", source: "osint" } }
    ]);

    fireEvent.click(screen.getByText("清单"));

    expect(screen.getByText("scope 外线索")).toBeInTheDocument();
    expect(screen.getByText("已脱敏")).toBeInTheDocument();
    expect(screen.getByText("外部导入")).toBeInTheDocument();
    // The warning is shown because at least one node is an unactionable lead.
    expect(screen.getByText(/仅作为线索保留/)).toBeInTheDocument();
  });

  it("does not treat an in-scope host as a lead", () => {
    renderView([
      osintNode("op:in-scope", "Host", "example.com", {
        classification: "in_scope",
        validationStatus: "pending"
      })
    ]);

    fireEvent.click(screen.getByText("清单"));

    expect(screen.queryByText("scope 外线索")).toBeNull();
  });

  it("filters the graph payload as well as the list", () => {
    renderView([
      osintNode("op:org", "Organization", "甲公司", {}),
      osintNode("op:phone", "Contact", "138****0000", { masked: true })
    ], [{ from: "op:org", to: "op:phone", type: "reachable_at", properties: {}, evidenceRefs: [] }]);

    const passed = graphSpy.mock.calls.at(-1)?.[0] as { edges: GraphEdge[] };
    expect(passed.edges).toHaveLength(1);

    // Narrowing to organizations must drop the edge whose far endpoint vanished.
    fireEvent.mouseDown(screen.getByLabelText("实体类型"));
    fireEvent.click(screen.getByText("组织主体"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    const filtered = graphSpy.mock.calls.at(-1)?.[0] as { nodes: GraphNode[]; edges: GraphEdge[] };
    expect(filtered.nodes.map((node) => node.id)).toEqual(["op:org"]);
    expect(filtered.edges).toHaveLength(0);
  });

  it("reports a node with no recorded source rather than showing a blank cell", () => {
    renderView([osintNode("op:bare", "Host", "example.com", {})]);
    fireEvent.click(screen.getByText("清单"));
    expect(screen.getByText("无来源记录")).toBeInTheDocument();
  });
});
