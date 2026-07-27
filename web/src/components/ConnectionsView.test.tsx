import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConnections, mutateRoute } from "../api";
import type { AuthUser, ConnectionItem } from "../types";
import { ConnectionsView } from "./ConnectionsView";

vi.mock("../api", () => ({
  fetchConnections: vi.fn(),
  mutateRoute: vi.fn()
}));

const connection: ConnectionItem = {
  id: "connectivity-route:primary",
  externalId: "route:primary",
  kind: "route",
  direction: "host-a → host-b",
  transport: "ssh",
  managed: true,
  actions: ["status", "stop", "reconnect", "forget"],
  desiredState: "running",
  observedState: "degraded",
  lastHeartbeat: "2026-07-20T10:00:00.000Z",
  error: "SSH probe failed",
  available: false,
  connectionRef: "connection:primary",
  sessionRef: "connection:primary",
  graphUrl: "?view=operation&nodeId=connectivity-tunnel%3Aprimary"
};

const admin: AuthUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-07-20T00:00:00.000Z"
};
const analyst: AuthUser = { ...admin, id: "analyst-1", username: "analyst", role: "analyst" };
const mockedFetch = vi.mocked(fetchConnections);
const mockedMutate = vi.mocked(mutateRoute);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue({
    runtimeDir: "runtime/a",
    loadedAt: new Date().toISOString(),
    runtimeControl: { active: true, mode: "controller" },
    connections: [connection]
  });
  mockedMutate.mockResolvedValue({ ...connection, desiredState: "stopped", observedState: "stale" });
});

describe("ConnectionsView", () => {
  it("shows lifecycle state, attribution limits and graph navigation", async () => {
    render(<ConnectionsView runtimeDir="runtime/a" user={analyst} />);

    await screen.findByText("route:primary");
    expect(screen.getByText("host-a → host-b")).toBeInTheDocument();
    expect(screen.getByText("ssh")).toBeInTheDocument();
    expect(screen.getByText("可控制")).toBeInTheDocument();
    expect(screen.getByText("期望状态: 运行中")).toBeInTheDocument();
    expect(screen.getByText("异常")).toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();
    expect(screen.queryByText(/credential:ssh-primary|Credential/)).not.toBeInTheDocument();
    expect(screen.getByText("SSH probe failed")).toBeInTheDocument();
    expect(screen.getAllByText("connection:primary")).toHaveLength(1);
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
    expect(screen.getByText(/活动和历史 Run 中均可重连/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /状态图/ })).toHaveAttribute("href", connection.graphUrl);
    expect(screen.queryByRole("button", { name: "启动" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password|private key/i)).not.toBeInTheDocument();
  });

  it("clears connections when switching to a runtime that fails to load", async () => {
    const { rerender } = render(<ConnectionsView runtimeDir="runtime/a" user={analyst} />);
    await screen.findByText("route:primary");

    mockedFetch.mockRejectedValueOnce(new Error("runtime unavailable"));
    rerender(<ConnectionsView runtimeDir="runtime/b" user={analyst} />);

    await screen.findByText("runtime unavailable");
    expect(screen.queryByText("route:primary")).not.toBeInTheDocument();
    expect(screen.getByText("当前 Runtime 暂无连接")).toBeInTheDocument();
  });

  it("lets only admins mutate managed connection lifecycle", async () => {
    render(<ConnectionsView runtimeDir="runtime/a" user={admin} />);
    await screen.findByText("route:primary");

    fireEvent.click(screen.getByRole("button", { name: /停止/ }));
    await waitFor(() => expect(mockedMutate).toHaveBeenCalledWith("runtime/a", connection.id, "stop"));
    expect(await screen.findByText("期望状态: 已停止")).toBeInTheDocument();
  });
});
