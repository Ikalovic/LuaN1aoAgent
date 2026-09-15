import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEnvConfig, fetchMcpServers, setMcpEnabled } from "../api";
import type { AuthUser, McpRegistrySnapshot } from "../types";
import { McpView } from "./McpView";

vi.mock("../api", () => ({
  fetchMcpServers: vi.fn(),
  setMcpEnabled: vi.fn(),
  fetchEnvConfig: vi.fn(),
  updateEnvConfig: vi.fn()
}));

const admin: AuthUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-08-30T00:00:00.000Z"
};
const analyst: AuthUser = { ...admin, id: "analyst-1", username: "analyst", role: "analyst" };
const snapshot: McpRegistrySnapshot = {
  scannedAt: "2026-08-30T00:00:00.000Z",
  servers: [
    {
      name: "credential",
      description: "Built-in credential store over the encrypted artifact database.",
      tools: ["credential_query", "credential_read", "credential_store", "credential_invalidate", "credential_list_by_role"],
      configured: true,
      enabled: true
    },
    {
      name: "fofa",
      description: "FOFA attack-surface search with scope-aware query quotas.",
      tools: ["fofa_account_info", "fofa_host_aggregate", "fofa_search", "fofa_search_next", "fofa_stats"],
      configured: false,
      enabled: true
    }
  ],
  diagnostics: [{ code: "mcp_not_configured", message: "FOFA MCP requires FOFA_API_KEY.", serverName: "fofa" }]
};

const mockedFetch = vi.mocked(fetchMcpServers);
const mockedSetEnabled = vi.mocked(setMcpEnabled);
const mockedFetchEnv = vi.mocked(fetchEnvConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(snapshot);
});

describe("McpView", () => {
  it("loads the MCP registry summary and filters servers", async () => {
    render(<McpView user={admin} />);

    await screen.findByText("credential");
    expect(screen.getByText("2 个服务器")).toBeInTheDocument();
    expect(screen.getByText("2 个已启用")).toBeInTheDocument();
    expect(screen.getByText("1 个未配置")).toBeInTheDocument();
    expect(screen.getByText("FOFA MCP requires FOFA_API_KEY.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索名称或描述"), { target: { value: "fofa" } });
    expect(screen.getByText("fofa")).toBeInTheDocument();
    expect(screen.queryByText("credential")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索名称或描述"), { target: { value: "" } });
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "MCP 状态" }));
    fireEvent.click(await screen.findByText("未配置", { selector: ".ant-select-item-option-content" }));
    expect(screen.getByText("fofa")).toBeInTheDocument();
    expect(screen.queryByText("credential")).not.toBeInTheDocument();
  });

  it("lets administrators toggle one enabled server", async () => {
    const disabled = { ...snapshot.servers[0], enabled: false };
    mockedFetch
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, servers: [disabled, snapshot.servers[1]] });
    mockedSetEnabled.mockResolvedValue(disabled);
    render(<McpView user={admin} />);

    fireEvent.click(await screen.findByRole("switch", { name: "credential" }));

    await waitFor(() => expect(mockedSetEnabled).toHaveBeenCalledWith("credential", false));
    await waitFor(() => expect(screen.getByRole("switch", { name: "credential" })).not.toBeChecked());
  });

  it("keeps analyst and unconfigured server switches read-only", async () => {
    const { rerender } = render(<McpView user={analyst} />);

    expect(await screen.findByRole("switch", { name: "credential" })).toBeDisabled();

    rerender(<McpView user={admin} />);
    expect(screen.getByRole("switch", { name: "credential" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "fofa" })).toBeDisabled();
    expect(mockedSetEnabled).not.toHaveBeenCalled();
  });

  it("shows a retryable load failure", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("registry unavailable"));
    render(<McpView user={admin} />);

    expect(await screen.findByText("registry unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("credential")).toBeInTheDocument();
  });

  it("keeps the prior state when a mutation fails", async () => {
    mockedSetEnabled.mockRejectedValueOnce(new Error("update rejected"));
    render(<McpView user={admin} />);
    const toggle = await screen.findByRole("switch", { name: "credential" });

    fireEvent.click(toggle);

    expect(await screen.findByText("update rejected")).toBeInTheDocument();
    expect(toggle).toBeChecked();
  });

  it("offers environment configuration to administrators only", async () => {
    mockedFetchEnv.mockResolvedValue({ path: "/tmp/.env", entries: [], updatedAt: null });
    const { rerender } = render(<McpView user={analyst} />);
    await screen.findByText("credential");
    expect(screen.queryByRole("button", { name: "环境配置" })).not.toBeInTheDocument();

    rerender(<McpView user={admin} />);
    fireEvent.click(screen.getByRole("button", { name: "环境配置" }));

    await waitFor(() => expect(mockedFetchEnv).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("环境配置（.env）")).toBeInTheDocument();
  });
});
