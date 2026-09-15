import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TraceItem } from "../types";
import { AgentDetailDrawer } from "./AgentDetailDrawer";

function traceItem(overrides: Partial<TraceItem> & { id: string; role: string; timestamp: string }): TraceItem {
  return {
    eventId: `event-${overrides.id}`,
    eventType: "assistant_intent",
    eventLabel: "Agent 想法",
    stage: "思考摘要",
    title: "规划判断",
    summary: "测试摘要",
    intentSource: "recorded",
    detail: "",
    evidenceRefs: [],
    artifactRefs: [],
    graphNodeRefs: [],
    rawEvent: {},
    ...overrides
  };
}

const recent = new Date(Date.now() - 5_000).toISOString();
const older = new Date(Date.now() - 180_000).toISOString();

const plannerItems: TraceItem[] = [
  traceItem({
    id: "t-planner-2",
    role: "planner",
    timestamp: recent,
    title: "Planner 更新任务计划",
    stage: "规划决策",
    summary: "最新决策摘要",
    decision: "保留一个待执行任务",
    commandDetails: ["nmap -sV target"]
  }),
  traceItem({ id: "t-planner-1", role: "planner", timestamp: older, title: "Planner 请求用户输入", summary: "较早的规划摘要" })
];

const executorItem = traceItem({ id: "t-executor-1", role: "executor", timestamp: recent, title: "Executor 执行动作", summary: "执行摘要" });

describe("AgentDetailDrawer", () => {
  it("shows the current work and recent activity for the selected agent only", () => {
    render(
      <AgentDetailDrawer
        open
        role="planner"
        agent={{ timestamp: recent, summary: "规划事件" }}
        eventCount={7}
        traceItems={[...plannerItems, executorItem]}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Planner 更新任务计划")).toBeInTheDocument();
    expect(screen.getByText("最新决策摘要")).toBeInTheDocument();
    expect(screen.getByText("保留一个待执行任务")).toBeInTheDocument();
    expect(screen.getByText("nmap -sV target")).toBeInTheDocument();
    expect(screen.getByText("Planner 请求用户输入")).toBeInTheDocument();
    expect(screen.getByText("7 条事件")).toBeInTheDocument();
    expect(screen.getByText("最近有活动")).toBeInTheDocument();
    expect(screen.queryByText("Executor 执行动作")).not.toBeInTheDocument();
  });

  it("links the current work and activity rows back to the live trace", () => {
    const onSelectTrace = vi.fn();
    render(
      <AgentDetailDrawer open role="planner" traceItems={plannerItems} onClose={() => {}} onSelectTrace={onSelectTrace} />
    );

    fireEvent.click(screen.getByRole("button", { name: "在运行轨迹中查看" }));
    expect(onSelectTrace).toHaveBeenCalledWith("t-planner-2");

    fireEvent.click(screen.getByRole("button", { name: /Planner 请求用户输入/ }));
    expect(onSelectTrace).toHaveBeenCalledWith("t-planner-1");
  });

  it("falls back to the latest raw event when no trace item exists", () => {
    render(
      <AgentDetailDrawer
        open
        role="runtime"
        agent={{ timestamp: older, eventType: "control_signal", summary: "控制信号已应用" }}
        traceItems={[]}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("控制信号已应用")).toBeInTheDocument();
    expect(screen.getByText("最近活动", { selector: ".agent-detail-state" })).toBeInTheDocument();
    expect(screen.getByText("该 Agent 暂无活动记录")).toBeInTheDocument();
  });

  it("renders empty states when the agent has no events at all", () => {
    render(<AgentDetailDrawer open role="observer" traceItems={[]} onClose={() => {}} />);

    expect(screen.getByText("该 Agent 尚未产生事件")).toBeInTheDocument();
    expect(screen.getByText("该 Agent 暂无活动记录")).toBeInTheDocument();
  });

  it("shows the role description per agent", () => {
    render(<AgentDetailDrawer open role="executor" traceItems={[executorItem]} onClose={() => {}} />);
    expect(screen.getByText("执行任务步骤、调用工具并提交任务结果")).toBeInTheDocument();
  });
});
