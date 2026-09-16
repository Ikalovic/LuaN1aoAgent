import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSpecialistOptionsMode, updateSpecialistOptions } from "../api";
import type { RegisteredSpecialist } from "../types";
import { SpecialistOptionsDrawer } from "./SpecialistOptionsDrawer";

vi.mock("../api", () => ({
  updateSpecialistOptions: vi.fn(),
  setSpecialistOptionsMode: vi.fn()
}));

const specialist: RegisteredSpecialist = {
  id: "bruteforce",
  name: "爆破/口令猜测 Agent",
  description: "对已确认的认证入口执行受控的口令猜测。",
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
      spec: { type: "number", title: "并发线程数", description: "目标锁定策略严格时应调低。", default: 4, minimum: 1, maximum: 64, integer: true },
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

const mockedSave = vi.mocked(updateSpecialistOptions);
const mockedMode = vi.mocked(setSpecialistOptionsMode);

beforeEach(() => {
  vi.clearAllMocks();
  mockedSave.mockResolvedValue(specialist);
  mockedMode.mockResolvedValue({ ...specialist, optionsMode: "user" });
});

describe("SpecialistOptionsDrawer", () => {
  it("renders author-fixed options read-only with their author default", async () => {
    render(<SpecialistOptionsDrawer specialist={specialist} onClose={() => {}} />);

    expect(await screen.findAllByText("作者固定")).toHaveLength(2);
    expect(screen.getByText("作者默认：true")).toBeInTheDocument();
    expect(screen.getByText("作者默认：-")).toBeInTheDocument();
    expect(screen.getByLabelText("wordlist")).toBeDisabled();
    expect(screen.getByLabelText("stopOnLockout")).toBeDisabled();
    expect(screen.getByLabelText("threads")).toBeEnabled();
  });

  it("renders a planner number as an upper bound with its range hint", async () => {
    render(<SpecialistOptionsDrawer specialist={specialist} onClose={() => {}} />);

    expect(await screen.findByText("上限")).toBeInTheDocument();
    expect(screen.getByText("Planner 将在 [1, 64] 内选择具体取值。")).toBeInTheDocument();
    const threads = screen.getByLabelText("threads");
    expect(threads).toHaveAttribute("aria-valuemax", "64");
    expect(threads).toHaveValue("64");
  });

  it("submits only editable keys", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SpecialistOptionsDrawer specialist={specialist} onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(await screen.findByLabelText("threads"), { target: { value: "8" } });
    fireEvent.click(screen.getByText(/保\s*存/));

    await waitFor(() => expect(mockedSave).toHaveBeenCalledWith("bruteforce", { threads: 8 }));
    expect(onSaved).toHaveBeenCalledWith(specialist);
    expect(onClose).toHaveBeenCalled();
  });

  it("switches the option authority mode immediately", async () => {
    const onSaved = vi.fn();
    render(<SpecialistOptionsDrawer specialist={specialist} onClose={() => {}} onSaved={onSaved} />);

    expect(await screen.findByText("作者默认：Planner 指定")).toBeInTheDocument();
    expect(screen.queryByText("已覆盖作者默认")).toBeNull();
    expect(screen.getByRole("button", { name: /恢复作者默认/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "用户指定" }));

    await waitFor(() => expect(mockedMode).toHaveBeenCalledWith("bruteforce", "user"));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ optionsMode: "user" }));
    // The mode is committed on its own, never as part of the option save.
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("flags an overridden mode and resets it to the author default", async () => {
    render(
      <SpecialistOptionsDrawer
        specialist={{ ...specialist, optionsMode: "user" }}
        onClose={() => {}}
      />
    );

    expect(await screen.findByText("已覆盖作者默认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /恢复作者默认/ }));

    await waitFor(() => expect(mockedMode).toHaveBeenCalledWith("bruteforce", null));
  });
});
