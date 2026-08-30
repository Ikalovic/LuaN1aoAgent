import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseScopeDocument, startRun } from "../api";
import { StartRunModal } from "./StartRunModal";

vi.mock("../api", () => ({
  parseScopeDocument: vi.fn(),
  startRun: vi.fn()
}));

const parsed = {
  documentId: "11111111-1111-4111-8111-111111111111",
  fileName: "scope.txt",
  domains: [{ value: "api.example", source: "rule" as const, evidence: { line: 1, excerpt: "允许 api.example" } }],
  ipv4Cidrs: [{ value: "10.0.0.1/32", source: "rule" as const, evidence: { line: 2, excerpt: "允许 10.0.0.1" } }],
  normalizedScope: "10.0.0.1/32,api.example",
  diagnostics: []
};

const mockedParse = vi.mocked(parseScopeDocument);
const mockedStart = vi.mocked(startRun);

beforeEach(() => {
  vi.clearAllMocks();
  mockedParse.mockResolvedValue(parsed);
  mockedStart.mockResolvedValue({
    runtimeDir: ".agent-runtime/sessions/example",
    name: "example",
    goal: "test",
    scope: parsed.normalizedScope,
    taskType: "pentest",
    startedAt: new Date().toISOString(),
    running: true
  });
});

describe("StartRunModal", () => {
  it("accepts XLSX authorization files", () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    expect(screen.getByLabelText("授权范围文件"))
      .toHaveAttribute("accept", expect.stringContaining(".xlsx"));
  });

  it("submits a CTF run without an explicit scope", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.mouseDown(screen.getByLabelText("任务类型"));
    fireEvent.click(await screen.findByText("CTF 题目"));
    await waitFor(() => expect(screen.getAllByTitle("CTF 题目").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "完成 CTF 挑战" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "完成 CTF 挑战",
      scope: "",
      taskType: "ctf"
    })));
  });

  it("still requires a scope for pentest runs", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "执行渗透测试" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    expect(await screen.findByText("请输入授权范围")).toBeInTheDocument();
    expect(mockedStart).not.toHaveBeenCalled();
  });

  it("uploads, previews, confirms, and submits the exact parsed document scope", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("授权范围文件"), {
      target: { files: [new File(["api.example\n10.0.0.1"], "scope.txt", { type: "text/plain" })] }
    });

    expect(await screen.findByText("api.example")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.1/32")).toBeInTheDocument();
    expect(screen.getByText("允许 api.example")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: /启\s*动/ });
    expect(start).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /确认使用以上解析范围/ }));
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "测试授权资产" } });
    fireEvent.click(start);

    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "测试授权资产",
      scope: "",
      scopeDocumentId: parsed.documentId,
      confirmedDocumentScope: parsed.normalizedScope
    })));
  });

  it("keeps the legacy manual-scope submission unchanged", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "手工范围测试" } });
    fireEvent.change(screen.getByLabelText("授权范围"), { target: { value: "manual.example" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "手工范围测试",
      scope: "manual.example"
    })));
    expect(mockedStart.mock.calls[0][0]).not.toHaveProperty("scopeDocumentId");
  });
});
