import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "./AgentsPanel";
import { fetchSpecialists, setSpecialistEnabled, setSpecialistOptionsMode, updateSpecialistOptions } from "../api";
import type { AuthUser, RegisteredSpecialist, SpecialistRegistrySnapshot } from "../types";

vi.mock("../api", () => ({
  fetchSpecialists: vi.fn(),
  setSpecialistEnabled: vi.fn(),
  updateSpecialistOptions: vi.fn(),
  setSpecialistOptionsMode: vi.fn()
}));

const admin: AuthUser = { id: "admin-1", username: "admin", displayName: "Admin", role: "admin", createdAt: "2026-09-16T00:00:00.000Z" };
const analyst: AuthUser = { ...admin, id: "analyst-1", username: "analyst", role: "analyst" };

const bruteforce: RegisteredSpecialist = {
  id: "bruteforce",
  name: "爆破/口令猜测 Agent",
  description: "对已确认的认证入口执行受控的口令猜测。",
  whenToUse: "认证入口已确认时使用。",
  source: "builtin",
  enabled: true,
  valid: true,
  introspected: true,
  executability: "prompt-only",
  promptMode: "extend",
  enabledGroups: ["sandbox", "research", "credentials", "submit"],
  disabledGroups: ["network_diagnostics", "fofa", "beekeeper"],
  deniedTools: [],
  skillMode: "allowlist",
  budget: { defaultMaxTurns: 16, maxTurnsCeiling: 24, epochTurnSlice: 12, epochTimeShare: 0.7 },
  concurrency: { maxParallelTasks: 1 },
  optionsMode: "planner",
  authorOptionsMode: "planner",
  options: [
    {
      key: "threads",
      spec: { type: "number", title: "并发线程数", default: 4, minimum: 1, maximum: 64, integer: true },
      value: 4,
      isDefault: true,
      authority: "planner",
      editable: true,
      boundOnly: true,
      bounds: { minimum: 1, maximum: 64 },
      authorDefault: 4
    },
    {
      key: "wordlist",
      spec: { type: "string", title: "字典路径或来源", default: "" },
      value: "",
      isDefault: true,
      authority: "author",
      editable: false,
      boundOnly: false,
      authorDefault: ""
    },
    {
      key: "stopOnLockout",
      spec: { type: "boolean", title: "检测到锁定即停止", default: true },
      value: true,
      isDefault: true,
      authority: "author",
      editable: false,
      boundOnly: false,
      authorDefault: true
    }
  ],
  diagnostics: []
};

const general: RegisteredSpecialist = {
  ...bruteforce,
  id: "general",
  name: "通用 Executor",
  description: "默认执行者。",
  disabledGroups: [],
  skillMode: "auto",
  options: []
};

const broken: RegisteredSpecialist = {
  ...bruteforce,
  id: "broken-agent",
  name: "Broken",
  description: "模块加载失败",
  source: "project",
  valid: false,
  introspected: false,
  executability: "module",
  options: [],
  diagnostics: [{ code: "specialist_module_failed", message: "Specialist broken-agent module failed to load", specialistId: "broken-agent" }]
};

function snapshot(specialists: RegisteredSpecialist[]): SpecialistRegistrySnapshot {
  return {
    scannedAt: "2026-09-16T00:00:00.000Z",
    specialists,
    diagnostics: specialists.flatMap((specialist) => specialist.diagnostics)
  };
}

describe("AgentsPanel", () => {
  const mockedFetch = vi.mocked(fetchSpecialists);
  const mockedToggle = vi.mocked(setSpecialistEnabled);
  const mockedOptions = vi.mocked(updateSpecialistOptions);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue(snapshot([bruteforce, general, broken]));
    mockedToggle.mockResolvedValue({ ...bruteforce, enabled: false });
    mockedOptions.mockResolvedValue(bruteforce);
  });

  afterEach(cleanup);

  it("renders the registry with budgets, capability narrowing and diagnostics", async () => {
    render(<AgentsPanel user={admin} />);
    expect(await screen.findByText("bruteforce")).toBeInTheDocument();
    expect(screen.getByText("3 个 Agent")).toBeInTheDocument();
    expect(screen.getByText("1 个无效")).toBeInTheDocument();
    expect(screen.getAllByText("16 轮 / 上限 24 / 片 12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Skill：allowlist").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/specialist_module_failed|module failed to load/).length).toBeGreaterThan(0);
  });

  it("filters by query and status", async () => {
    render(<AgentsPanel user={admin} />);
    await screen.findByText("bruteforce");
    fireEvent.change(screen.getByPlaceholderText("搜索 Agent 名称、用途或适用边界"), { target: { value: "口令" } });
    expect(await screen.findByText("bruteforce")).toBeInTheDocument();
    expect(screen.queryByText("general")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("搜索 Agent 名称、用途或适用边界"), { target: { value: "" } });
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "专精 Agent 状态" }));
    fireEvent.click(await screen.findByText("无效", { selector: ".ant-select-item-option-content" }));
    expect(await screen.findByText("broken-agent")).toBeInTheDocument();
    expect(screen.queryByText("bruteforce")).toBeNull();
  });

  it("lets administrators toggle a Specialist and keeps the general Agent locked", async () => {
    render(<AgentsPanel user={admin} />);
    const toggle = await screen.findByRole("switch", { name: "bruteforce" });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockedToggle).toHaveBeenCalledWith("bruteforce", false));

    const generalSwitch = screen.getByRole("switch", { name: "general" });
    expect(generalSwitch).toBeDisabled();
    fireEvent.click(generalSwitch);
    expect(mockedToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps analysts read-only", async () => {
    render(<AgentsPanel user={analyst} />);
    const toggle = await screen.findByRole("switch", { name: "bruteforce" });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(mockedToggle).not.toHaveBeenCalled();
    expect(screen.getByText("分析员只能查看专精 Agent 状态与配置。")).toBeInTheDocument();
  });

  it("saves Specialist options through the schema-driven drawer", async () => {
    render(<AgentsPanel user={admin} />);
    await screen.findByText("bruteforce");
    fireEvent.click(screen.getByRole("button", { name: "专精 Agent 选项 bruteforce" }));
    const threads = await screen.findByLabelText("threads");
    fireEvent.change(threads, { target: { value: "8" } });
    fireEvent.click(screen.getByText(/保\s*存/));
    // Author-fixed keys never reach the request body: the server rejects a write
    // that touches one, so the drawer must filter them out.
    await waitFor(() => expect(mockedOptions).toHaveBeenCalledWith("bruteforce", { threads: 8 }));
  });
  it("refreshes the open drawer after changing option ownership", async () => {
    vi.mocked(setSpecialistOptionsMode).mockResolvedValueOnce({ ...bruteforce, optionsMode: "user" });
    render(<AgentsPanel user={admin} />);
    await screen.findByText("bruteforce");
    fireEvent.click(screen.getByRole("button", { name: "专精 Agent 选项 bruteforce" }));
    fireEvent.click(screen.getByRole("radio", { name: "用户指定" }));
    await waitFor(() => expect(setSpecialistOptionsMode).toHaveBeenCalledWith("bruteforce", "user"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "用户指定" })).toBeChecked());
  });

  it("marks author-fixed capabilities and partially fixed options", async () => {
    render(<AgentsPanel user={admin} />);
    await screen.findByText("bruteforce");

    expect(screen.getAllByText("作者固定").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "专精 Agent 选项 general" })).toBeDisabled();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "专精 Agent 选项 bruteforce" }));
    expect(await screen.findByText("部分参数由作者固定")).toBeInTheDocument();
  });

  it("reports load and mutation failures without flipping state", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("registry unavailable"));
    const { unmount } = render(<AgentsPanel user={admin} />);
    expect(await screen.findByText("registry unavailable")).toBeInTheDocument();
    unmount();

    mockedFetch.mockResolvedValue(snapshot([bruteforce, general]));
    mockedToggle.mockRejectedValueOnce(new Error("toggle rejected"));
    render(<AgentsPanel user={admin} />);
    const toggle = await screen.findByRole("switch", { name: "bruteforce" });
    fireEvent.click(toggle);
    expect(await screen.findByText("toggle rejected")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "bruteforce" })).toBeChecked();
  });
});
