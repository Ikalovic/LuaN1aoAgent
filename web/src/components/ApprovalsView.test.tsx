import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Modal, type ModalFuncProps } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideApproval, fetchApprovals, updateApprovalMode } from "../api";
import type { ApprovalsResponse, AuthUser } from "../types";
import { ApprovalsView } from "./ApprovalsView";

vi.mock("../api", () => ({
  fetchApprovals: vi.fn(),
  decideApproval: vi.fn(),
  updateApprovalMode: vi.fn()
}));

vi.mock("antd", async (importOriginal: () => Promise<unknown>) => {
  const actual = (await importOriginal()) as typeof import("antd");
  return { ...actual, Modal: { ...actual.Modal, confirm: vi.fn() } };
});

const admin: AuthUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-08-30T00:00:00.000Z"
};
const analyst: AuthUser = { ...admin, id: "analyst-1", username: "analyst", role: "analyst" };

function snapshot(approvals: ApprovalsResponse["approvals"] = []): ApprovalsResponse {
  return {
    loadedAt: "2026-09-06T00:00:00.000Z",
    mode: "auto",
    approvals
  };
}

function pendingApproval(overrides: Partial<ApprovalsResponse["approvals"][number]> = {}) {
  return {
    id: "approval-1",
    runId: "run:1",
    runtimeDir: "run-a",
    taskId: "task:1",
    taskGoal: "Find the flag on the authorized target",
    scopeSummary: "10.0.0.0/24",
    toolName: "bash",
    toolArgs: JSON.stringify({ command: "nmap -sV 10.0.0.5" }, null, 2),
    intent: "对目标主机执行服务探测",
    riskLevel: "high" as const,
    reason: "扫描可能扩大攻击面",
    createdAt: "2026-09-06T00:00:00.000Z",
    status: "pending" as const,
    ...overrides
  };
}

const mockedFetch = vi.mocked(fetchApprovals);
const mockedDecide = vi.mocked(decideApproval);
const mockedUpdate = vi.mocked(updateApprovalMode);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(snapshot([]));
  mockedUpdate.mockResolvedValue({ ok: true, mode: "strict" });
  vi.mocked(Modal.confirm).mockImplementation((config: ModalFuncProps) => {
    config.onOk?.();
    return { destroy: () => undefined, update: () => undefined };
  });
});

describe("ApprovalsView", () => {
  it("renders the pending approval card with intent, risk and context", async () => {
    mockedFetch.mockResolvedValue(snapshot([pendingApproval()]));
    render(<ApprovalsView user={admin} />);

    await screen.findByText("bash");
    expect(screen.getByText("对目标主机执行服务探测")).toBeInTheDocument();
    expect(screen.getByText("扫描可能扩大攻击面")).toBeInTheDocument();
    expect(screen.getByText("高")).toBeInTheDocument();
    expect(screen.getByText(/nmap -sV/)).toBeInTheDocument();
    expect(screen.getByText("Find the flag on the authorized target")).toBeInTheDocument();
    expect(screen.getByText("1 个待批准请求")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is pending", async () => {
    render(<ApprovalsView user={admin} />);
    await screen.findByText("当前没有待批准的危险操作");
    expect(screen.getByText("0 个待批准请求")).toBeInTheDocument();
  });

  it("approves a pending request and refreshes the list", async () => {
    // The view re-fetches whenever the pending count changes, so keep one
    // approval visible until a decision has actually been made.
    mockedFetch.mockImplementation(async () => {
      return mockedDecide.mock.calls.length > 0 ? snapshot([]) : snapshot([pendingApproval()]);
    });
    mockedDecide.mockResolvedValue({ ok: true, approvalId: "approval-1", decision: "approve" });
    const onPendingChange = vi.fn();
    render(<ApprovalsView user={admin} onPendingChange={onPendingChange} />);

    fireEvent.click(await screen.findByText("批准执行"));
    await waitFor(() => expect(mockedDecide).toHaveBeenCalledWith("approval-1", "approve"));
    await screen.findByText("当前没有待批准的危险操作");
    expect(onPendingChange).toHaveBeenCalledWith(0);
  });

  it("denies a pending request after confirmation", async () => {
    // The view re-fetches whenever the pending count changes, so keep one
    // approval visible until a decision has actually been made.
    mockedFetch.mockImplementation(async () => {
      return mockedDecide.mock.calls.length > 0 ? snapshot([]) : snapshot([pendingApproval()]);
    });
    mockedDecide.mockResolvedValue({ ok: true, approvalId: "approval-1", decision: "deny" });
    render(<ApprovalsView user={admin} />);

    fireEvent.click(await screen.findByText("拒绝"));
    const confirm = await screen.findByText("只有管理员可以批准或拒绝危险操作");
    expect(confirm).toBeInTheDocument();
    // antd inserts a space between two-character button labels ("拒 绝").
    fireEvent.click(screen.getByText("拒 绝"));
    await waitFor(() => expect(mockedDecide).toHaveBeenCalledWith("approval-1", "deny"));
    await screen.findByText("当前没有待批准的危险操作");
  });

  it("reports the pending count through the callback", async () => {
    mockedFetch.mockResolvedValue(snapshot([pendingApproval(), pendingApproval({ id: "approval-2", toolName: "write" })]));
    const onPendingChange = vi.fn();
    render(<ApprovalsView user={admin} onPendingChange={onPendingChange} />);
    await screen.findByText("write");
    expect(onPendingChange).toHaveBeenCalledWith(2);
  });

  it("disables decisions for analysts and shows the read-only note", async () => {
    mockedFetch.mockResolvedValue(snapshot([pendingApproval()]));
    render(<ApprovalsView user={analyst} />);

    const approve = await screen.findByText("批准执行");
    expect(approve.closest("button")).toBeDisabled();
    expect(screen.getByText("你的账号无权处理批准请求")).toBeInTheDocument();
  });

  it("surfaces load errors with a retry action", async () => {
    mockedFetch
      .mockRejectedValueOnce(new Error("网络错误"))
      .mockResolvedValueOnce(snapshot([]));
    render(<ApprovalsView user={admin} />);

    await screen.findByText(/网络错误/);
    // antd inserts a space between two-character button labels ("重 试").
    fireEvent.click(screen.getByText("重 试"));
    await screen.findByText("当前没有待批准的危险操作");
  });

  it("lets an admin switch the approval mode and shows the result", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, mode: "strict" });
    render(<ApprovalsView user={admin} />);

    fireEvent.click(await screen.findByText("严格（每次调用均需批准）"));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("strict"));
    expect(await screen.findByText(/批准模式已切换为/)).toBeInTheDocument();
  });

  it("asks for confirmation before switching to off", async () => {
    vi.mocked(Modal.confirm).mockImplementation((config: ModalFuncProps) => {
      config.onCancel?.();
      return { destroy: () => undefined, update: () => undefined };
    });
    render(<ApprovalsView user={admin} />);

    fireEvent.click(await screen.findByText("关闭（不拦截）"));
    await waitFor(() => expect(mockedUpdate).not.toHaveBeenCalled());
  });

  it("surfaces switch failures without changing the selection", async () => {
    mockedUpdate.mockRejectedValue(new Error("服务端拒绝"));
    render(<ApprovalsView user={admin} />);

    fireEvent.click(await screen.findByText("严格（每次调用均需批准）"));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith("strict"));
    expect(await screen.findByText(/切换批准模式失败/)).toBeInTheDocument();
  });

  it("shows a read-only mode label for analysts instead of the switcher", async () => {
    render(<ApprovalsView user={analyst} />);
    await screen.findByText("当前没有待批准的危险操作");
    expect(screen.getByText(/批准模式：/)).toBeInTheDocument();
    expect(screen.queryByText("关闭（不拦截）")).not.toBeInTheDocument();
  });
});
