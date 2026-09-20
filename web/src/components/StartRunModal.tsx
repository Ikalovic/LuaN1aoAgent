import { useRef, useState } from "react";
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from "antd";
import { Paperclip } from "lucide-react";
import { discardAttachment, parseScopeDocument, startRun, uploadAttachment } from "../api";
import { useLanguage } from "../language";
import type { ParsedScopeDocument, StagedAttachment } from "../types";

/** Mirrors ATTACHMENT_LIMITS in src/attachments/attachment-store.ts; the server is authoritative. */
const ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_MAX_FILES = 12;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

interface StartRunModalProps {
  open: boolean;
  onClose: () => void;
  onStarted: (runtimeDir: string) => void;
  continueFrom?: {
    runtimeDir: string;
    goal: string;
    scopeSummary?: string;
    taskType?: "ctf" | "pentest";
  };
}

export function StartRunModal({ open, onClose, onStarted, continueFrom }: StartRunModalProps) {
  const { t } = useLanguage();
  const [form] = Form.useForm();
  const continuing = Boolean(continueFrom);
  const taskType = Form.useWatch("taskType", form) ?? continueFrom?.taskType ?? "pentest";
  const [submitting, setSubmitting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string>();
  const [parsedDocument, setParsedDocument] = useState<ParsedScopeDocument>();
  const [scopeDraft, setScopeDraft] = useState("");
  const [editingScopeDraft, setEditingScopeDraft] = useState(false);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const resetDocument = () => {
    setParsedDocument(undefined);
    setScopeDraft("");
    setEditingScopeDraft(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const resetAttachments = () => {
    setAttachments([]);
    setAttachmentError(undefined);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  };

  /**
   * Files are staged one by one as they are picked, so the run request stays
   * small and a single rejected file does not discard the accepted ones.
   */
  const selectAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    setAttachmentError(undefined);
    if (attachments.length + incoming.length > ATTACHMENT_MAX_FILES) {
      setAttachmentError(t("startRun.attachmentTooMany").replace("{max}", String(ATTACHMENT_MAX_FILES)));
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }
    const oversized = incoming.find((file) => file.size > ATTACHMENT_MAX_BYTES);
    if (oversized) {
      setAttachmentError(t("startRun.attachmentTooLarge").replace("{max}", formatBytes(ATTACHMENT_MAX_BYTES)));
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }
    setUploading(true);
    const uploaded: StagedAttachment[] = [];
    try {
      for (const file of incoming) {
        uploaded.push(await uploadAttachment(file));
      }
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAttachments((current) => [...current, ...uploaded]);
      setUploading(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.attachmentId !== attachmentId));
    // Staged files are released on successful start anyway; a failed discard
    // only means the staging copy outlives the UI list.
    await discardAttachment(attachmentId).catch(() => undefined);
  };

  const selectDocument = async (file: File | undefined) => {
    resetDocument();
    if (!file) return;
    setParsing(true);
    setError(undefined);
    try {
      const parsed = await parseScopeDocument(file);
      setParsedDocument(parsed);
      setScopeDraft(parsed.normalizedScope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setParsing(false);
    }
  };

  const addScopeDraft = () => {
    const entries = [String(form.getFieldValue("scope") ?? ""), scopeDraft]
      .flatMap((value) => value.split(/[\s,，;；]+/u))
      .map((value) => value.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const merged = entries.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (merged.length === 0) return;
    form.setFieldValue("scope", merged.join(","));
    void form.validateFields(["scope"]).catch(() => undefined);
    resetDocument();
  };

  const submit = async () => {
    if (submitting || uploading || parsing) return;
    const values = await form.validateFields();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await startRun({
        goal: String(values.goal).trim(),
        scope: String(values.scope ?? "").trim(),
        taskType: values.taskType ?? continueFrom?.taskType ?? "pentest",
        ...(continueFrom ? { runtimeDir: continueFrom.runtimeDir } : {}),
        maxRunTimeMs: values.maxRunTimeMin ? Math.round(values.maxRunTimeMin * 60_000) : undefined,
        maxParallelTasks: values.maxParallelTasks ?? undefined,
        maxPlannerCycles: values.maxPlannerCycles ?? undefined,
        ...(attachments.length > 0 ? { attachmentIds: attachments.map((item) => item.attachmentId) } : {})
      });
      form.resetFields();
      resetDocument();
      resetAttachments();
      onStarted(result.runtimeDir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={continuing ? t("startRun.continueTitle") : t("startRun.title")}
      open={open}
      okText={continuing ? t("startRun.continueAction") : t("common.start")}
      cancelText={t("common.cancel")}
      confirmLoading={submitting}
      okButtonProps={{ disabled: parsing || uploading }}
      cancelButtonProps={{ disabled: submitting || uploading || parsing }}
      closable={!submitting && !uploading && !parsing}
      keyboard={!submitting && !uploading && !parsing}
      mask={{ closable: !submitting && !uploading && !parsing }}
      width={560}
      destroyOnHidden
      onOk={() => void submit().catch(() => undefined)}
      onCancel={() => {
        if (submitting || uploading || parsing) return;
        for (const item of attachments) void discardAttachment(item.attachmentId).catch(() => undefined);
        setError(undefined);
        resetDocument();
        resetAttachments();
        onClose();
      }}
    >
      {error ? <Alert style={{ marginBottom: 12 }} type="error" showIcon title={error} /> : null}
      {continuing ? <Alert style={{ marginBottom: 12 }} type="info" showIcon title={t("startRun.continueHint")} /> : null}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          taskType: continueFrom?.taskType ?? "pentest",
          goal: continueFrom?.goal ?? undefined,
          scope: continueFrom?.scopeSummary ?? undefined,
          maxRunTimeMin: 15,
          maxParallelTasks: 2,
          maxPlannerCycles: 8
        }}
      >
        <Form.Item name="taskType" label={t("startRun.taskType")}>
          <Select options={[
            { value: "pentest", label: t("startRun.pentest") },
            { value: "ctf", label: t("startRun.ctf") }
          ]} />
        </Form.Item>
        <Typography.Text type="secondary">{t("startRun.taskTypeHint")}</Typography.Text>
        <Form.Item name="goal" label={t("startRun.goal")} rules={[{ required: true, whitespace: true, message: t("startRun.goalRequired") }]}>
          <Input.TextArea rows={4} maxLength={4000} placeholder={t("startRun.goalPlaceholder")} />
        </Form.Item>
        <Form.Item name="scope" label={t("startRun.scope")} dependencies={["taskType"]} rules={taskType === "ctf" ? [] : [{
          validator: (_, value) => String(value ?? "").trim()
            ? Promise.resolve()
            : Promise.reject(new Error(t("startRun.scopeRequired")))
        }]}>
          <Input.TextArea rows={3} maxLength={4000} placeholder={t("startRun.scopePlaceholder")} />
        </Form.Item>
        <Form.Item label={t("startRun.scopeFile")}>
          <input
            ref={fileInputRef}
            aria-label={t("startRun.scopeFile")}
            type="file"
            accept=".txt,.md,.csv,.json,.docx,.xlsx,.pdf"
            disabled={parsing || submitting}
            onChange={(event) => void selectDocument(event.currentTarget.files?.[0])}
          />
        </Form.Item>
        <Form.Item label={t("startRun.attachments")} className="qx-start-attachments">
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            <input
              ref={attachmentInputRef}
              className="qx-start-file-input"
              aria-label={t("startRun.attachments")}
              type="file"
              multiple
              disabled={uploading || submitting}
              onChange={(event) => void selectAttachments(event.currentTarget.files)}
            />
            <Button icon={<Paperclip size={15} />} loading={uploading} disabled={uploading || submitting} onClick={() => attachmentInputRef.current?.click()}>{t("startRun.attachments")}</Button>
            <Typography.Text type="secondary">{t("startRun.attachmentsHint")}</Typography.Text>
            {attachmentError ? <Alert type="error" showIcon title={attachmentError} /> : null}
            {attachments.length > 0 ? (
              <Space size={[4, 4]} wrap>
                {attachments.map((item) => (
                  <Tag
                    key={item.attachmentId}
                    closable={!submitting}
                    onClose={(event) => {
                      event.preventDefault();
                      void removeAttachment(item.attachmentId);
                    }}
                    title={`${item.mediaType} · ${formatBytes(item.byteLength)}`}
                  >
                    {item.fileName} · {formatBytes(item.byteLength)}
                  </Tag>
                ))}
              </Space>
            ) : null}
          </Space>
        </Form.Item>
        {parsedDocument ? (
          <Alert
            type="info"
            showIcon
            title={t("startRun.scopePreview")}
            description={(
              <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                <Input.TextArea
                  aria-label={t("startRun.scopePreviewContent")}
                  rows={3}
                  value={scopeDraft}
                  readOnly={!editingScopeDraft}
                  onChange={(event) => setScopeDraft(event.target.value)}
                />
                <Space>
                  <Button disabled={editingScopeDraft} onClick={() => setEditingScopeDraft(true)}>
                    {t("startRun.modifyScopePreview")}
                  </Button>
                  <Button type="primary" disabled={!scopeDraft.trim()} onClick={addScopeDraft}>
                    {t("startRun.addScopePreview")}
                  </Button>
                </Space>
              </Space>
            )}
          />
        ) : null}
        <div className="qx-start-limits">
          <Form.Item name="maxRunTimeMin" label={t("startRun.maxMinutes")} style={{ flex: 1 }}>
            <InputNumber min={1} max={180} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxParallelTasks" label={t("startRun.parallelTasks")} style={{ flex: 1 }}>
            <InputNumber min={1} max={8} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxPlannerCycles" label={t("startRun.plannerCycles")} style={{ flex: 1 }}>
            <InputNumber min={1} max={64} style={{ width: "100%" }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}
