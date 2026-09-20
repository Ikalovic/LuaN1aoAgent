import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discardAttachment, parseScopeDocument, startRun, uploadAttachment } from "../api";
import { StartRunModal } from "./StartRunModal";

vi.mock("../api", () => ({
  parseScopeDocument: vi.fn(),
  startRun: vi.fn(),
  uploadAttachment: vi.fn(),
  discardAttachment: vi.fn()
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
const mockedUpload = vi.mocked(uploadAttachment);
const mockedDiscard = vi.mocked(discardAttachment);

function stagedAttachment(fileName: string, byteLength = 1024) {
  return {
    attachmentId: `11111111-1111-4111-8111-${fileName.padEnd(12, "0").slice(0, 12)}`,
    fileName,
    mediaType: "application/octet-stream",
    byteLength,
    sha256: "a".repeat(64),
    createdAt: new Date(0).toISOString()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedParse.mockResolvedValue(parsed);
  mockedDiscard.mockResolvedValue({ ok: true });
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

  it("edits and appends parsed scope without document confirmation fields", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("授权范围"), {
      target: { value: "manual.example,api.example" }
    });
    fireEvent.change(screen.getByLabelText("授权范围文件"), {
      target: { files: [new File(["api.example\n10.0.0.1"], "scope.txt", { type: "text/plain" })] }
    });

    const preview = await screen.findByLabelText("文件解析范围内容");
    expect(preview).toHaveValue(parsed.normalizedScope);
    expect(preview).toHaveAttribute("readonly");

    fireEvent.click(screen.getByRole("button", { name: /修\s*改/ }));
    expect(preview).not.toHaveAttribute("readonly");
    fireEvent.change(preview, {
      target: { value: "api.example,10.0.0.1/32,extra.example" }
    });
    const fileInput = screen.getByLabelText("授权范围文件");
    Object.defineProperty(fileInput, "value", {
      configurable: true,
      writable: true,
      value: "C:\\fakepath\\scope.txt"
    });
    fireEvent.click(screen.getByRole("button", { name: /添\s*加/ }));

    expect(screen.getByLabelText("授权范围")).toHaveValue(
      "manual.example,api.example,10.0.0.1/32,extra.example"
    );
    expect(fileInput).toHaveValue("");
    expect(screen.queryByLabelText("文件解析范围内容")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "测试授权资产" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "测试授权资产",
      scope: "manual.example,api.example,10.0.0.1/32,extra.example"
    })));
    expect(mockedStart.mock.calls[0][0]).not.toHaveProperty("scopeDocumentId");
    expect(mockedStart.mock.calls[0][0]).not.toHaveProperty("confirmedDocumentScope");
  });

  it("does not treat an unadded file preview as pentest scope", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("授权范围文件"), {
      target: { files: [new File(["api.example"], "scope.txt", { type: "text/plain" })] }
    });
    await screen.findByLabelText("文件解析范围内容");
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "执行渗透测试" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    expect(await screen.findByText("请输入授权范围")).toBeInTheDocument();
    expect(mockedStart).not.toHaveBeenCalled();
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

  it("prefills stored goal and scope in continuation mode and submits runtimeDir", async () => {
    render(<StartRunModal
      open
      onClose={() => undefined}
      onStarted={() => undefined}
      continueFrom={{
        runtimeDir: ".agent-runtime/sessions/prior",
        goal: "既有目标",
        scopeSummary: "api.example",
        taskType: "pentest"
      }}
    />);

    expect(screen.getByText("基于已有成果继续渗透")).toBeInTheDocument();
    expect(screen.getByText("将在该会话已有任务图、成果、凭据与工件的基础上重开 Root Goal 并开始新一轮规划；可修改目标与授权范围。")).toBeInTheDocument();
    expect(screen.getByLabelText("任务目标")).toHaveValue("既有目标");
    expect(screen.getByLabelText("授权范围")).toHaveValue("api.example");

    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "换一个目标继续" } });
    fireEvent.click(screen.getByRole("button", { name: /继\s*续\s*渗\s*透/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "换一个目标继续",
      scope: "api.example",
      runtimeDir: ".agent-runtime/sessions/prior"
    })));
  });

  it("does not carry continuation fields into a plain start", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);
    expect(screen.getByText("启动新任务")).toBeInTheDocument();
    expect(screen.queryByText("将在该会话已有任务图、成果、凭据与工件的基础上重开 Root Goal 并开始新一轮规划；可修改目标与授权范围。")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "全新任务" } });
    fireEvent.change(screen.getByLabelText("授权范围"), { target: { value: "new.example" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "全新任务",
      scope: "new.example"
    })));
    expect(mockedStart.mock.calls[0][0]).not.toHaveProperty("runtimeDir");
  });

  it("stages picked files and submits their ids with the run", async () => {
    mockedUpload
      .mockResolvedValueOnce(stagedAttachment("chall.zip", 2048))
      .mockResolvedValueOnce(stagedAttachment("pcap.bin", 4096));
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.mouseDown(screen.getByLabelText("任务类型"));
    fireEvent.click(await screen.findByText("CTF 题目"));
    await waitFor(() => expect(screen.getAllByTitle("CTF 题目").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "解这道题" } });
    fireEvent.change(screen.getByLabelText("任务附件"), {
      target: {
        files: [
          new File(["zipbytes"], "chall.zip", { type: "application/zip" }),
          new File(["pcapbytes"], "pcap.bin", { type: "application/octet-stream" })
        ]
      }
    });

    expect(await screen.findByText(/chall\.zip/)).toBeInTheDocument();
    expect(screen.getByText(/pcap\.bin/)).toBeInTheDocument();
    expect(mockedUpload).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));
    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: "解这道题",
      taskType: "ctf",
      attachmentIds: [
        expect.stringContaining("11111111-1111-4111-8111-"),
        expect.stringContaining("11111111-1111-4111-8111-")
      ]
    })));
  });

  it("omits attachmentIds entirely when nothing was picked", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);
    fireEvent.mouseDown(screen.getByLabelText("任务类型"));
    fireEvent.click(await screen.findByText("CTF 题目"));
    await waitFor(() => expect(screen.getAllByTitle("CTF 题目").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "无附件" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalled());
    expect(mockedStart.mock.calls[0][0]).not.toHaveProperty("attachmentIds");
  });

  it("removing a staged attachment discards it server-side", async () => {
    mockedUpload.mockResolvedValueOnce(stagedAttachment("wrong-file.zip", 512));
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("任务附件"), {
      target: { files: [new File(["x"], "wrong-file.zip")] }
    });
    const tag = await screen.findByText(/wrong-file\.zip/);

    fireEvent.click(tag.closest(".ant-tag")!.querySelector(".ant-tag-close-icon") as HTMLElement);
    await waitFor(() => expect(mockedDiscard).toHaveBeenCalledWith(
      expect.stringContaining("11111111-1111-4111-8111-")
    ));
    expect(screen.queryByText(/wrong-file\.zip/)).not.toBeInTheDocument();
  });

  it("refuses an oversized file before uploading it", async () => {
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    const oversized = new File(["x"], "huge.img");
    // The limit is checked on the File, so spoof its size rather than allocating 32 MiB.
    Object.defineProperty(oversized, "size", { value: 33 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("任务附件"), { target: { files: [oversized] } });

    expect(await screen.findByText(/单个附件不能超过/)).toBeInTheDocument();
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it("surfaces an upload failure and still allows starting without attachments", async () => {
    mockedUpload.mockRejectedValueOnce(new Error("附件不存在或已失效，请重新上传"));
    render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);

    fireEvent.change(screen.getByLabelText("任务附件"), {
      target: { files: [new File(["x"], "bad.bin")] }
    });
    expect(await screen.findByText("附件不存在或已失效，请重新上传")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText("任务类型"));
    fireEvent.click(await screen.findByText("CTF 题目"));
    await waitFor(() => expect(screen.getAllByTitle("CTF 题目").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));

    await waitFor(() => expect(mockedStart).toHaveBeenCalled());
    expect(mockedStart.mock.calls[0][0]).not.toHaveProperty("attachmentIds");
  });
});
