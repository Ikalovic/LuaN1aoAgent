import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewView } from "./OverviewView";
import { buildSituation } from "../situation";
import type { RuntimeState, TraceItem } from "../types";
vi.mock("./GraphView", () => ({ GraphView: () => <div /> }));
vi.mock("./ActivityChart", async (importOriginal) => ({ ...await importOriginal<typeof import("./ActivityChart")>(), ActivityChart: () => <div /> }));
describe("overview event drilldown", () => {
  it("filters only recent events and preserves exact trace identity on click", () => {
    const traceItems = [
      { id: "recent", timestamp: "2026-09-15T12:00:00Z", role: "executor", title: "Recent command", eventType: "tool_result" },
      { id: "old", timestamp: "2026-09-15T10:00:00Z", role: "planner", title: "Old decision", eventType: "assistant" }
    ] as TraceItem[];
    const data = { loadedAt: "2026-09-15T12:05:00Z", traceItems } as RuntimeState;
    const navigate = vi.fn();
    render(<OverviewView data={data} situation={buildSituation()} navigation={{ runtimeDir: "run", view: "overview", range: "15m" }} onNavigate={navigate} onSelectNode={vi.fn()} onAgent={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Recent command.*tool_result/ }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ view: "trace", traceId: "recent" }));
    expect(screen.queryByRole("button", { name: /Old decision.*assistant/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /主机/ })).toHaveTextContent("--");
  });
});
