import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeSession } from "../types";
import { Sidebar } from "./Sidebar";

const idleSession: RuntimeSession = {
  name: "prior-run",
  runtimeDir: ".agent-runtime/sessions/prior-run",
  relativePath: "sessions/prior-run",
  isRoot: false,
  updatedAt: new Date().toISOString(),
  source: "sqlite",
  nodeCount: 2,
  edgeCount: 1,
  taskCount: 1,
  eventCount: 3,
  artifactCount: 1,
  goal: "既有目标",
  scopeSummary: "api.example",
  rootGoalStatus: "completed",
  taskType: "pentest",
  running: false
};

describe("Sidebar", () => {
  it("opens Web Traffic through the dedicated traffic view", () => {
    const onViewChange = vi.fn();
    render(
      <Sidebar
        activeView="trace"
        runtimeDir="runtime/a"
        sessions={[]}
        agents={{}}
        onViewChange={onViewChange}
        onRuntimeChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Web Traffic"));
    expect(onViewChange).toHaveBeenCalledWith("traffic");
  });

  it("opens the Skills management view", () => {
    const onViewChange = vi.fn();
    render(
      <Sidebar
        activeView="trace"
        runtimeDir="runtime/a"
        sessions={[]}
        agents={{}}
        onViewChange={onViewChange}
        onRuntimeChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Skills"));
    expect(onViewChange).toHaveBeenCalledWith("skills");
  });

  it("offers a continue action for idle sessions", () => {
    const onContinue = vi.fn();
    render(
      <Sidebar
        activeView="trace"
        runtimeDir="runtime/other"
        sessions={[idleSession]}
        agents={{}}
        onViewChange={vi.fn()}
        onRuntimeChange={vi.fn()}
        onContinue={onContinue}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /继续渗透/ }));
    expect(onContinue).toHaveBeenCalledWith(idleSession);
  });

  it("hides the continue action while a session is running or when onContinue is absent", () => {
    const running = { ...idleSession, running: true };
    const { rerender } = render(
      <Sidebar
        activeView="trace"
        runtimeDir="runtime/other"
        sessions={[running]}
        agents={{}}
        onViewChange={vi.fn()}
        onRuntimeChange={vi.fn()}
        onContinue={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /继续渗透/ })).not.toBeInTheDocument();

    rerender(
      <Sidebar
        activeView="trace"
        runtimeDir="runtime/other"
        sessions={[idleSession]}
        agents={{}}
        onViewChange={vi.fn()}
        onRuntimeChange={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /继续渗透/ })).not.toBeInTheDocument();
  });
});
