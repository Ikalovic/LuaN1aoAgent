import { useRef, useState } from "react";
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Typography } from "antd";
import { parseScopeDocument, startRun } from "../api";
import { useLanguage } from "../language";
import type { ParsedScopeDocument } from "../types";

interface StartRunModalProps {
  open: boolean;
  onClose: () => void;
  onStarted: (runtimeDir: string) => void;
}

export function StartRunModal({ open, onClose, onStarted }: StartRunModalProps) {
  const { t } = useLanguage();
  const [form] = Form.useForm();
  const taskType = Form.useWatch("taskType", form) ?? "pentest";
  const [submitting, setSubmitting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string>();
  const [parsedDocument, setParsedDocument] = useState<ParsedScopeDocument>();
  const [scopeDraft, setScopeDraft] = useState("");
  const [editingScopeDraft, setEditingScopeDraft] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetDocument = () => {
    setParsedDocument(undefined);
    setScopeDraft("");
    setEditingScopeDraft(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
    const values = await form.validateFields();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await startRun({
        goal: String(values.goal).trim(),
        scope: String(values.scope ?? "").trim(),
        taskType: values.taskType ?? "pentest",
        maxRunTimeMs: values.maxRunTimeMin ? Math.round(values.maxRunTimeMin * 60_000) : undefined,
        maxParallelTasks: values.maxParallelTasks ?? undefined,
        maxPlannerCycles: values.maxPlannerCycles ?? undefined
      });
      form.resetFields();
      resetDocument();
      onStarted(result.runtimeDir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("startRun.title")}
      open={open}
      okText={t("common.start")}
      cancelText={t("common.cancel")}
      confirmLoading={submitting}
      okButtonProps={{ disabled: parsing }}
      width={560}
      destroyOnHidden
      onOk={() => void submit().catch(() => undefined)}
      onCancel={() => {
        if (submitting) return;
        setError(undefined);
        resetDocument();
        onClose();
      }}
    >
      {error ? <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} /> : null}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ taskType: "pentest", maxRunTimeMin: 15, maxParallelTasks: 2, maxPlannerCycles: 8 }}
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
        <div style={{ display: "flex", gap: 12 }}>
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
