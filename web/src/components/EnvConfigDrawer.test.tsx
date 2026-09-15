import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEnvConfig, updateEnvConfig } from "../api";
import type { EnvConfigView } from "../types";
import { EnvConfigDrawer } from "./EnvConfigDrawer";

vi.mock("../api", () => ({
  fetchEnvConfig: vi.fn(),
  updateEnvConfig: vi.fn()
}));

const view: EnvConfigView = {
  path: "/project/.env",
  updatedAt: "2026-09-15T00:00:00.000Z",
  entries: [
    { key: "LLM_API_KEY", sensitive: true, preview: "••••1234" },
    { key: "FOFA_EMAIL", sensitive: false, value: "ops@example.com" }
  ]
};

const mockedFetch = vi.mocked(fetchEnvConfig);
const mockedUpdate = vi.mocked(updateEnvConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(view);
  mockedUpdate.mockResolvedValue(view);
});

describe("EnvConfigDrawer", () => {
  it("renders saved entries with masked sensitive values", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);

    await screen.findByText("LLM_API_KEY");
    expect(screen.getByText("••••1234")).toBeInTheDocument();
    expect(screen.getByText("ops@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/sk-/)).not.toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("stages an edit and saves it in one request", async () => {
    const onSaved = vi.fn();
    render(<EnvConfigDrawer open onClose={() => {}} onSaved={onSaved} />);
    await screen.findByText("FOFA_EMAIL");

    fireEvent.click(screen.getAllByRole("button", { name: /编\s*辑/ })[1]);
    const input = screen.getByDisplayValue("ops@example.com");
    fireEvent.change(input, { target: { value: "fresh@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /应\s*用/ }));

    expect(screen.getByText("待保存")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({
      set: { FOFA_EMAIL: "fresh@example.com" },
      remove: []
    }));
    expect(await screen.findByText("已保存到 .env，并对之后启动的任务生效")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it("stages a new variable and a removal together", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");

    fireEvent.change(screen.getByPlaceholderText("变量名，如 FOFA_API_KEY"), { target: { value: "FOFA_API_KEY" } });
    fireEvent.change(screen.getByPlaceholderText("变量值"), { target: { value: "abcdefgh1234" } });
    fireEvent.click(screen.getByRole("button", { name: /添\s*加/ }));
    expect(await screen.findByText("新增")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /删\s*除/ })[0]);
    expect(screen.getByText("待删除")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({
      set: { FOFA_API_KEY: "abcdefgh1234" },
      remove: ["LLM_API_KEY"]
    }));
  });

  it("restores a staged removal", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");

    fireEvent.click(screen.getAllByRole("button", { name: /删\s*除/ })[0]);
    expect(screen.getByText("待删除")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /撤\s*销/ }));

    expect(screen.queryByText("待删除")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存更改" })).toBeDisabled();
  });

  it("rejects invalid new entries", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");

    fireEvent.change(screen.getByPlaceholderText("变量名，如 FOFA_API_KEY"), { target: { value: "BAD KEY" } });
    fireEvent.change(screen.getByPlaceholderText("变量值"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /添\s*加/ }));
    expect(await screen.findByText("变量名需以字母或下划线开头，仅含字母、数字、下划线")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("变量名，如 FOFA_API_KEY"), { target: { value: "GOOD_KEY" } });
    fireEvent.change(screen.getByPlaceholderText("变量值"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /添\s*加/ }));
    expect(await screen.findByText("变量值不能为空")).toBeInTheDocument();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("reloads after a load failure", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("env unavailable"));
    render(<EnvConfigDrawer open onClose={() => {}} />);

    expect(await screen.findByText("env unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("LLM_API_KEY")).toBeInTheDocument();
  });

  it("surfaces a save failure", async () => {
    mockedUpdate.mockRejectedValueOnce(new Error("write denied"));
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");

    fireEvent.click(screen.getAllByRole("button", { name: /删\s*除/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    expect(await screen.findByText("write denied")).toBeInTheDocument();
    expect(screen.getByText("待删除")).toBeInTheDocument();
  });

  it("keeps a staged sensitive edit masked", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");
    fireEvent.click(screen.getAllByRole("button", { name: /编\s*辑/ })[0]);
    const input = screen.getByPlaceholderText("输入新值");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /应\s*用/ }));
    expect(screen.queryByText("replacement-secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ set: { LLM_API_KEY: "replacement-secret" }, remove: [] }));
  });

  it("discards unsubmitted input and masks new variables", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");
    const key = screen.getByPlaceholderText("变量名，如 FOFA_API_KEY");
    const value = screen.getByPlaceholderText("变量值");
    fireEvent.change(key, { target: { value: "NEW_TOKEN" } });
    fireEvent.change(value, { target: { value: "new-secret" } });
    expect(value).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "放弃更改" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(key).toHaveValue("");
    expect(value).toHaveValue("");
    fireEvent.change(key, { target: { value: "NEW_TOKEN" } });
    fireEvent.change(value, { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /添\s*加/ }));
    expect(screen.queryByText("new-secret")).not.toBeInTheDocument();
  });

  it("filters by variable name without changing the staged batch", async () => {
    render(<EnvConfigDrawer open onClose={() => {}} />);
    await screen.findByText("LLM_API_KEY");
    fireEvent.click(screen.getAllByRole("button", { name: /删\s*除/ })[0]);
    fireEvent.change(screen.getByPlaceholderText("搜索变量名"), { target: { value: "fofa" } });
    expect(screen.queryByText("LLM_API_KEY")).not.toBeInTheDocument();
    expect(screen.getByText("FOFA_EMAIL")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith({ set: {}, remove: ["LLM_API_KEY"] }));
  });
});
