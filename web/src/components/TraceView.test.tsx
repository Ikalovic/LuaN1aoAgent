import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TraceItem } from "../types";
import { TraceCard, TraceView } from "./TraceView";

const actionItem: TraceItem = {
  id: "trace:action:1",
  eventId: "event:1",
  timestamp: "2026-07-10T17:27:20.883Z",
  taskId: "task:test",
  role: "executor",
  eventType: "agent_action",
  eventLabel: "Agent 动作",
  stage: "思考与行动",
  title: "Executor 执行动作",
  summary: "准备验证当前入口并收集直接证据。",
  intentSource: "recorded",
  detail: "Agent 动作 → 工具调用开始 → 工具调用完成",
  action: "bash · curl http://target.test",
  observation: "工具返回内容",
  evidenceRefs: [],
  artifactRefs: [],
  graphNodeRefs: ["task:test"],
  tool: {
    toolCallId: "call:1",
    toolName: "bash",
    command: "curl http://target.test",
    status: "completed",
    isError: false,
    startedAt: "2026-07-10T17:27:20.881Z",
    endedAt: "2026-07-10T17:27:20.883Z",
    durationMs: 2,
    updateCount: 0,
    eventCount: 3,
    result: "工具返回内容",
    resultPreview: "工具返回内容",
    lifecycle: [
      { eventType: "tool_started", timestamp: "2026-07-10T17:27:20.881Z" },
      { eventType: "tool_finished", timestamp: "2026-07-10T17:27:20.883Z" }
    ]
  },
  rawEvent: { id: "action:1" }
};

describe("TraceView", () => {
  it("does not expose Runtime as a LIVE TRACE role", () => {
    render(
      <TraceView
        items={[]}
        planningCheckpoints={[]}
        taskOutcomes={[]}
        epochOutcomes={[]}
        tasks={[]}
        roleFilter="all"
        newestFirst
        onRoleFilterChange={vi.fn()}
        onOrderChange={vi.fn()}
        onSelectTrace={vi.fn()}
      />
    );

    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Executor")).toBeInTheDocument();
    expect(screen.getByText("Observer")).toBeInTheDocument();
    expect(screen.queryByText("Runtime")).not.toBeInTheDocument();
  });

  it("previews thought and action while keeping tool output collapsed", () => {
    render(<TraceCard item={actionItem} selected={false} onSelect={vi.fn()} />);

    expect(screen.getByText("Agent 想法")).toBeInTheDocument();
    expect(screen.getByText("准备验证当前入口并收集直接证据。")).toBeInTheDocument();
    expect(screen.getByText("执行动作")).toBeInTheDocument();
    expect(screen.getByText("bash · curl http://target.test")).toBeInTheDocument();
    expect(screen.queryByText("工具返回内容")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("展开执行细节"));

    expect(screen.getAllByText("工具返回内容").length).toBeGreaterThan(0);
    expect(screen.getByText("tool started")).toBeInTheDocument();
    expect(screen.getByText("tool finished")).toBeInTheDocument();
  });

  it("groups task epochs and the latest TaskOutcome under a Planner decision", () => {
    render(
      <TraceView
        items={[{ ...actionItem, seq: 6 }]}
        planningCheckpoints={[{
          id: "planner:1",
          index: 1,
          kind: "initial",
          startSeq: 1,
          startedAt: "2026-07-10T17:27:00.000Z",
          status: "completed",
          reason: "验证入口并归档报告",
          inputTaskRefs: [],
          createdTaskRefs: ["task:test"],
          updatedTaskRefs: [],
          executionTaskRefs: ["task:test"],
          taskRefs: ["task:test"],
          traceItemIds: [actionItem.id]
        }]}
        taskOutcomes={[{
          taskRef: "task:test",
          epochRef: "epoch:2",
          status: "completed",
          summary: "已完成验证并生成结构化结论。",
          evidenceRefs: [],
          artifactRefs: [],
          capabilityRefs: [],
          terminalSeq: 9,
          createdAt: "2026-07-10T17:28:00.000Z"
        }]}
        epochOutcomes={[
          { epochRef: "epoch:1", taskRef: "task:test", status: "checkpointed", reason: "继续验证", terminalSeq: 5, retryable: true, createdAt: "2026-07-10T17:27:30.000Z" },
          { epochRef: "epoch:2", taskRef: "task:test", status: "submitted", reason: "已提交", terminalSeq: 9, retryable: false, createdAt: "2026-07-10T17:28:00.000Z" }
        ]}
        tasks={[{ id: "task:test", label: "验证入口", status: "completed" }]}
        roleFilter="all"
        newestFirst={false}
        onRoleFilterChange={vi.fn()}
        onOrderChange={vi.fn()}
        onSelectTrace={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /初始规划/ })).toBeInTheDocument();
    expect(screen.getByText("新建")).toBeInTheDocument();
    expect(screen.getAllByText("活跃任务")).toHaveLength(2);
    expect(screen.getAllByText("验证入口并归档报告")).toHaveLength(2);
    expect(screen.getByText("首次规划，没有前序 TaskOutcome；依据 Root Goal 与 Scope 创建入口任务。")).toBeInTheDocument();
    expect(screen.getByText("已完成验证并生成结构化结论。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /验证入口.*completed/ }));

    expect(screen.getByText("checkpointed")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
  });

  it("switches Planner decisions without presenting them as execution rounds", () => {
    const { container } = render(
      <TraceView
        items={[]}
        planningCheckpoints={[
          {
            id: "planner:1",
            index: 1,
            kind: "initial",
            startSeq: 1,
            startedAt: "2026-07-10T17:27:00.000Z",
            status: "completed",
            reason: "首轮入口验证",
            inputTaskRefs: [],
            createdTaskRefs: ["task:first"],
            updatedTaskRefs: [],
            executionTaskRefs: ["task:first"],
            taskRefs: ["task:first"],
            traceItemIds: []
          },
          {
            id: "planner:2",
            index: 2,
            kind: "update",
            startSeq: 10,
            startedAt: "2026-07-10T17:30:00.000Z",
            status: "completed",
            reason: "二轮证据补充",
            inputTaskRefs: ["task:first"],
            createdTaskRefs: ["task:second"],
            updatedTaskRefs: ["task:first"],
            executionTaskRefs: ["task:second"],
            taskRefs: ["task:second"],
            traceItemIds: []
          }
        ]}
        taskOutcomes={[]}
        epochOutcomes={[]}
        tasks={[
          { id: "task:first", label: "验证首轮入口", status: "completed" },
          { id: "task:second", label: "补充二轮证据", status: "running" }
        ]}
        roleFilter="all"
        newestFirst={false}
        onRoleFilterChange={vi.fn()}
        onOrderChange={vi.fn()}
        onSelectTrace={vi.fn()}
      />
    );

    expect(screen.getAllByText("二轮证据补充")).toHaveLength(2);
    expect(screen.getByText("补充二轮证据")).toBeInTheDocument();
    expect(within(container.querySelector(".planning-input-note") as HTMLElement).getByText("验证首轮入口")).toBeInTheDocument();
    expect(within(container.querySelector(".planning-task-list") as HTMLElement).queryByText("验证首轮入口")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /初始规划/ }));

    expect(screen.getAllByText("首轮入口验证")).toHaveLength(2);
    expect(screen.getByText("验证首轮入口")).toBeInTheDocument();
    expect(screen.queryByText("补充二轮证据")).not.toBeInTheDocument();
  });

  it("labels derived historical intent as an action purpose and keeps task refs out of Evidence", () => {
    const { container } = render(<TraceCard item={{
      ...actionItem,
      intentSource: "derived",
      summary: "读取 ctf-web 技能指南，加载当前任务所需的验证方法。",
      evidenceRefs: []
    }} selected={false} onSelect={vi.fn()} />);
    const card = within(container);

    expect(card.getByText("行动目的")).toBeInTheDocument();
    expect(card.queryByText("Agent 想法")).not.toBeInTheDocument();
    expect(card.queryByText(/^Evidence /)).not.toBeInTheDocument();
  });
});
