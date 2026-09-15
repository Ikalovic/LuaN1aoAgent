import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCredential, deleteCredential, fetchCredentials, invalidateCredential, revealCredential } from "../api";
import type { CredentialsResponse } from "../types";
import { CredentialsView } from "./CredentialsView";

vi.mock("../api", () => ({
  fetchCredentials: vi.fn(),
  createCredential: vi.fn(),
  invalidateCredential: vi.fn(),
  revealCredential: vi.fn(),
  deleteCredential: vi.fn()
}));

const RUNTIME_DIR = "/tmp/runtime-a";
const SEEDED_REF = "artifact:11111111-1111-4111-8111-111111111111";
const INVALID_REF = "artifact:22222222-2222-4222-8222-222222222222";

const snapshot: CredentialsResponse = {
  runtimeDir: RUNTIME_DIR,
  available: true,
  scopes: ["run:seed-1", "run:web"],
  records: [
    {
      artifactRef: SEEDED_REF,
      scopeRef: "run:seed-1",
      kind: "cookie",
      hostRef: "portal.example",
      label: "portal session",
      username: "admin",
      role: "web_admin",
      source: "manual",
      valid: true,
      createdAt: "2026-09-01T02:00:00.000Z"
    },
    {
      artifactRef: INVALID_REF,
      scopeRef: "run:web",
      kind: "token",
      label: "api token",
      source: "agent",
      valid: false,
      createdAt: "2026-09-02T02:00:00.000Z"
    }
  ]
};

const mockedFetch = vi.mocked(fetchCredentials);
const mockedCreate = vi.mocked(createCredential);
const mockedInvalidate = vi.mocked(invalidateCredential);
const mockedReveal = vi.mocked(revealCredential);
const mockedDelete = vi.mocked(deleteCredential);
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(snapshot);
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

describe("CredentialsView", () => {
  it("renders the credential summary, records, and filters", async () => {
    render(<CredentialsView runtimeDir={RUNTIME_DIR} />);

    await screen.findByText("portal session");
    expect(mockedFetch).toHaveBeenCalledWith(RUNTIME_DIR, expect.anything());
    expect(screen.getByText("共 2 条")).toBeInTheDocument();
    expect(screen.getByText("有效 1 条")).toBeInTheDocument();
    expect(screen.getByText("失效 1 条")).toBeInTheDocument();
    expect(screen.getByText("api token")).toBeInTheDocument();
    expect(screen.getByText("已失效")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索标签 / 主机 / 用户名 / Scope"), { target: { value: "portal" } });
    expect(screen.getByText("portal session")).toBeInTheDocument();
    expect(screen.queryByText("api token")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索标签 / 主机 / 用户名 / Scope"), { target: { value: "" } });
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "状态筛选" }));
    fireEvent.click(await screen.findByText("仅失效", { selector: ".ant-select-item-option-content" }));
    expect(screen.getByText("api token")).toBeInTheDocument();
    expect(screen.queryByText("portal session")).not.toBeInTheDocument();
  });

  it("reveals a credential value and copies it to the clipboard", async () => {
    mockedReveal.mockResolvedValue({ ok: true, value: "secret-cookie-value" });
    render(<CredentialsView runtimeDir={RUNTIME_DIR} />);

    await screen.findByText("portal session");
    fireEvent.click(screen.getAllByText("查看值")[0]);

    await waitFor(() => expect(mockedReveal).toHaveBeenCalledWith(RUNTIME_DIR, SEEDED_REF));
    expect(await screen.findByDisplayValue("secret-cookie-value")).toBeInTheDocument();
    expect(screen.getByText(/查看明文将写入审计日志/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("复制"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("secret-cookie-value"));
    expect(await screen.findByText("已复制到剪贴板")).toBeInTheDocument();
  });

  it("creates a credential through the modal form", async () => {
    mockedCreate.mockResolvedValue({ ok: true, record: snapshot.records[0] });
    render(<CredentialsView runtimeDir={RUNTIME_DIR} />);

    await screen.findByText("portal session");
    fireEvent.click(screen.getByRole("button", { name: "新增凭据" }));
    fireEvent.change(await screen.findByLabelText("凭据值"), { target: { value: "fresh-secret" } });
    fireEvent.change(screen.getByLabelText("Scope（必填）"), { target: { value: "run:web" } });
    fireEvent.click(screen.getByText("创 建"));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(RUNTIME_DIR, {
      kind: "cookie",
      value: "fresh-secret",
      scopeRef: "run:web",
      hostRef: undefined,
      label: undefined,
      username: undefined,
      role: undefined
    }));
    expect(await screen.findByText("凭据已创建")).toBeInTheDocument();
  });

  it("keeps the modal open and surfaces backend rejections", async () => {
    mockedCreate.mockRejectedValue(new Error("credential_store_unavailable"));
    render(<CredentialsView runtimeDir={RUNTIME_DIR} />);

    await screen.findByText("portal session");
    fireEvent.click(screen.getByRole("button", { name: "新增凭据" }));
    fireEvent.change(await screen.findByLabelText("凭据值"), { target: { value: "fresh-secret" } });
    fireEvent.change(screen.getByLabelText("Scope（必填）"), { target: { value: "run:web" } });
    fireEvent.click(screen.getByText("创 建"));

    expect(await screen.findByText("credential_store_unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("凭据值")).toBeInTheDocument();
  });

  it("invalidates and deletes credentials through popconfirm", async () => {
    mockedInvalidate.mockResolvedValue({ ok: true });
    mockedDelete.mockResolvedValue({ ok: true });
    render(<CredentialsView runtimeDir={RUNTIME_DIR} />);

    await screen.findByText("portal session");
    const invalidateButtons = screen.getAllByText("标记失效");
    expect(invalidateButtons[invalidateButtons.length - 1].closest("button")).toBeDisabled();

    fireEvent.click(invalidateButtons[0]);
    await screen.findByText("确认将该凭据标记为失效？");
    const invalidateConfirms = screen.getAllByText("标记失效");
    fireEvent.click(invalidateConfirms[invalidateConfirms.length - 1]);
    await waitFor(() => expect(mockedInvalidate).toHaveBeenCalledWith(RUNTIME_DIR, SEEDED_REF));
    expect(await screen.findByText("凭据已标记失效")).toBeInTheDocument();

    const deleteButtons = screen.getAllByText("删 除");
    fireEvent.click(deleteButtons[0]);
    await screen.findByText("删除后索引与密钥文件都会被移除且不可恢复，确认删除？");
    const deleteConfirms = screen.getAllByText("删 除");
    fireEvent.click(deleteConfirms[deleteConfirms.length - 1]);
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(RUNTIME_DIR, SEEDED_REF));
    expect(await screen.findByText("凭据已删除")).toBeInTheDocument();
  });

  it("shows the unavailable notice for runtimes without a credential store", async () => {
    mockedFetch.mockResolvedValue({ runtimeDir: "/tmp/flat", available: false, records: [], scopes: [] });
    render(<CredentialsView runtimeDir="/tmp/flat" />);

    expect(await screen.findByText("所选 Runtime 尚未初始化凭据存储，请先启动一次任务。")).toBeInTheDocument();
    expect(screen.queryByText("portal session")).not.toBeInTheDocument();
  });

  it("surfaces load failures with a retry", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("store offline"));
    render(<CredentialsView runtimeDir={RUNTIME_DIR} />);

    expect(await screen.findByText("store offline")).toBeInTheDocument();
    fireEvent.click(screen.getByText("重新加载"));
    expect(await screen.findByText("portal session")).toBeInTheDocument();
  });
});
