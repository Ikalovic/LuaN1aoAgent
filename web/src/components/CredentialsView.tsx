import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AutoComplete, Button, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import { Copy, Plus, RefreshCw, Search } from "lucide-react";
import { createCredential, deleteCredential, fetchCredentials, invalidateCredential, revealCredential } from "../api";
import { useLanguage } from "../language";
import type { CredentialCreateInput, CredentialRecord, CredentialsResponse } from "../types";
import { formatRelative, formatTime, shortRef } from "../utils";

type CredentialStatusFilter = "all" | "valid" | "invalid";

const CREDENTIAL_KINDS = ["cookie", "token", "api_key", "password", "certificate", "ssh_key", "other"];

const KIND_COLORS: Record<string, string> = {
  cookie: "geekblue",
  token: "purple",
  api_key: "cyan",
  password: "orange",
  certificate: "green",
  ssh_key: "magenta",
  other: "default"
};

export function CredentialsView({ runtimeDir }: { runtimeDir: string }) {
  const { t } = useLanguage();
  const [view, setView] = useState<CredentialsResponse>();
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<CredentialStatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string }>();
  const [mutating, setMutating] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [revealed, setRevealed] = useState<{ record: CredentialRecord; value: string }>();
  const [form] = Form.useForm<CredentialCreateInput>();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchCredentials(runtimeDir, signal);
      if (!signal?.aborted) setView(next);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtimeDir]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const records = view?.records ?? [];
  const visible = useMemo(() => records.filter((record) => {
    const haystack = [record.label, record.hostRef, record.username, record.role, record.scopeRef, record.kind]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesQuery = haystack.includes(query.trim().toLowerCase());
    const matchesKind = kindFilter === "all" || record.kind === kindFilter;
    const matchesStatus = statusFilter === "all" || (statusFilter === "valid" ? record.valid : !record.valid);
    return matchesQuery && matchesKind && matchesStatus;
  }), [kindFilter, query, records, statusFilter]);
  const scopeOptions = useMemo(() => (view?.scopes ?? []).map((scope) => ({ value: scope })), [view]);
  const filtering = query.trim() !== "" || kindFilter !== "all" || statusFilter !== "all";

  const runAction = async (key: string, action: () => Promise<unknown>, successText: string) => {
    setMutating(key);
    setNotice(undefined);
    try {
      await action();
      await load();
      setNotice({ type: "success", text: successText });
    } catch (cause) {
      setNotice({ type: "error", text: `${t("credentials.actionFailed")}: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setMutating(undefined);
    }
  };

  const revealValue = async (record: CredentialRecord) => {
    setMutating(`${record.artifactRef}:reveal`);
    setNotice(undefined);
    try {
      const result = await revealCredential(runtimeDir, record.artifactRef);
      setRevealed({ record, value: result.value });
      await load();
    } catch (cause) {
      setNotice({ type: "error", text: `${t("credentials.actionFailed")}: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setMutating(undefined);
    }
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ type: "success", text: t("credentials.copied") });
    } catch {
      setNotice({ type: "error", text: t("credentials.copyFailed") });
    }
  };

  const submitCreate = async () => {
    let values: CredentialCreateInput;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    try {
      await createCredential(runtimeDir, {
        kind: values.kind,
        value: values.value,
        scopeRef: values.scopeRef.trim(),
        hostRef: optionalText(values.hostRef),
        label: optionalText(values.label),
        username: optionalText(values.username),
        role: optionalText(values.role)
      });
      setCreateOpen(false);
      form.resetFields();
      await load();
      setNotice({ type: "success", text: t("credentials.created") });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const columns: TableColumnsType<CredentialRecord> = [
    {
      title: t("credentials.columnKind"),
      dataIndex: "kind",
      key: "kind",
      width: 104,
      render: (kind: string) => <Tag color={KIND_COLORS[kind] ?? "default"}>{kind}</Tag>
    },
    {
      title: t("credentials.columnLabel"),
      dataIndex: "label",
      key: "label",
      render: (label: string, record) => (
        <div className="credentials-label">
          <Typography.Text strong>{label}</Typography.Text>
          {record.username ? <span>{record.username}</span> : null}
        </div>
      )
    },
    {
      title: t("credentials.columnHost"),
      dataIndex: "hostRef",
      key: "hostRef",
      width: 150,
      render: (hostRef?: string) => hostRef ? <Typography.Text code>{hostRef}</Typography.Text> : "-"
    },
    {
      title: t("credentials.columnScope"),
      dataIndex: "scopeRef",
      key: "scopeRef",
      width: 150,
      render: (scopeRef: string) => <Tooltip title={scopeRef}><span className="credentials-scope">{shortRef(scopeRef, 24)}</span></Tooltip>
    },
    {
      title: t("credentials.columnRole"),
      dataIndex: "role",
      key: "role",
      width: 96,
      render: (role?: string) => role || "-"
    },
    {
      title: t("credentials.columnSource"),
      dataIndex: "source",
      key: "source",
      width: 84,
      render: (source: string) => <Tag>{source}</Tag>
    },
    {
      title: t("credentials.columnValid"),
      dataIndex: "valid",
      key: "valid",
      width: 84,
      render: (valid: boolean) => <Tag color={valid ? "green" : "default"}>{valid ? t("credentials.validTag") : t("credentials.invalidTag")}</Tag>
    },
    {
      title: t("credentials.columnCreated"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 130,
      render: (createdAt: string, record) => (
        <Tooltip title={record.lastUsedAt ? t("credentials.lastUsed", { value: formatTime(record.lastUsedAt) }) : formatTime(createdAt)}>
          <span>{formatRelative(createdAt)}</span>
        </Tooltip>
      )
    },
    {
      title: t("credentials.columnActions"),
      key: "actions",
      width: 218,
      render: (_, record) => (
        <Space size={4}>
          <Button
            size="small"
            loading={mutating === `${record.artifactRef}:reveal`}
            onClick={() => void revealValue(record)}
          >
            {t("credentials.reveal")}
          </Button>
          <Popconfirm
            title={t("credentials.invalidateConfirm")}
            okText={t("credentials.invalidate")}
            cancelText={t("credentials.cancel")}
            onConfirm={() => void runAction(
              `${record.artifactRef}:invalidate`,
              () => invalidateCredential(runtimeDir, record.artifactRef),
              t("credentials.invalidated")
            )}
          >
            <Button size="small" disabled={!record.valid} loading={mutating === `${record.artifactRef}:invalidate`}>
              {t("credentials.invalidate")}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t("credentials.deleteConfirm")}
            okText={t("credentials.delete")}
            cancelText={t("credentials.cancel")}
            okButtonProps={{ danger: true }}
            onConfirm={() => void runAction(
              `${record.artifactRef}:delete`,
              () => deleteCredential(runtimeDir, record.artifactRef),
              t("credentials.deleted")
            )}
          >
            <Button size="small" danger loading={mutating === `${record.artifactRef}:delete`}>
              {t("credentials.delete")}
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div className="credentials-view">
      <div className="credentials-summary">
        <span>{t("credentials.total", { value: records.length })}</span>
        <span>{t("credentials.validTotal", { value: records.filter((record) => record.valid).length })}</span>
        <span>{t("credentials.invalidTotal", { value: records.filter((record) => !record.valid).length })}</span>
      </div>
      <div className="credentials-toolbar">
        <div>
          <Typography.Title level={5}>{t("nav.credentials")}</Typography.Title>
          <span>{t("credentials.description")}</span>
        </div>
        <div className="credentials-toolbar-controls">
          <Input
            allowClear
            prefix={<Search size={15} />}
            placeholder={t("credentials.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            aria-label={t("credentials.filterKind")}
            value={kindFilter}
            onChange={setKindFilter}
            options={[
              { value: "all", label: t("credentials.kindAll") },
              ...CREDENTIAL_KINDS.map((kind) => ({ value: kind, label: kind }))
            ]}
          />
          <Select<CredentialStatusFilter>
            aria-label={t("credentials.filterStatus")}
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "all", label: t("credentials.statusAll") },
              { value: "valid", label: t("credentials.statusValid") },
              { value: "invalid", label: t("credentials.statusInvalid") }
            ]}
          />
          <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>{t("credentials.refresh")}</Button>
          <Button type="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>{t("credentials.create")}</Button>
        </div>
      </div>
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void load()}>{t("credentials.reload")}</Button>} /> : null}
      {notice ? <Alert closable type={notice.type} showIcon title={notice.text} onClose={() => setNotice(undefined)} /> : null}
      {view && !view.available ? (
        <Alert type="info" showIcon title={t("credentials.unavailable")} />
      ) : loading && !view ? (
        <div className="credentials-loading"><Spin /></div>
      ) : (
        <Table<CredentialRecord>
          className="credentials-table"
          columns={columns}
          dataSource={visible}
          rowKey="artifactRef"
          pagination={false}
          size="small"
          scroll={{ x: 1080 }}
          locale={{ emptyText: filtering ? t("credentials.noMatches") : t("credentials.empty") }}
        />
      )}
      <Modal
        open={createOpen}
        title={t("credentials.createTitle")}
        okText={t("credentials.submit")}
        cancelText={t("credentials.cancel")}
        confirmLoading={submitting}
        width={560}
        destroyOnHidden
        onOk={() => void submitCreate()}
        onCancel={() => {
          if (submitting) return;
          setCreateOpen(false);
          setFormError(undefined);
          form.resetFields();
        }}
      >
        {formError ? <Alert style={{ marginBottom: 12 }} type="error" showIcon title={formError} /> : null}
        <Form form={form} layout="vertical" initialValues={{ kind: "cookie" }}>
          <Form.Item name="kind" label={t("credentials.formKind")} rules={[{ required: true }]}>
            <Select options={CREDENTIAL_KINDS.map((kind) => ({ value: kind, label: kind }))} />
          </Form.Item>
          <Form.Item
            name="value"
            label={t("credentials.formValue")}
            rules={[{ required: true, whitespace: true, message: t("credentials.formValueRequired") }]}
          >
            <Input.TextArea rows={4} placeholder={t("credentials.formValuePlaceholder")} />
          </Form.Item>
          <Form.Item
            name="scopeRef"
            label={t("credentials.formScope")}
            rules={[{ required: true, whitespace: true, message: t("credentials.formScopeRequired") }]}
          >
            <AutoComplete options={scopeOptions} placeholder={t("credentials.formScopeHint")} />
          </Form.Item>
          <Form.Item name="hostRef" label={`${t("credentials.formHost")} · ${t("credentials.formOptional")}`}>
            <Input autoComplete="off" />
          </Form.Item>
          <div style={{ display: "flex", gap: 12 }}>
            <Form.Item name="label" label={`${t("credentials.formLabel")} · ${t("credentials.formOptional")}`} style={{ flex: 1 }}>
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="username" label={`${t("credentials.formUsername")} · ${t("credentials.formOptional")}`} style={{ flex: 1 }}>
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="role" label={`${t("credentials.formRole")} · ${t("credentials.formOptional")}`} style={{ flex: 1 }}>
              <Input autoComplete="off" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
      <Modal
        open={Boolean(revealed)}
        title={t("credentials.revealTitle")}
        footer={<Button onClick={() => setRevealed(undefined)}>{t("common.close")}</Button>}
        width={560}
        destroyOnHidden
        onCancel={() => setRevealed(undefined)}
      >
        {revealed ? (
          <Space orientation="vertical" size={10} style={{ width: "100%" }}>
            <Alert type="warning" showIcon title={t("credentials.revealHint")} />
            <div className="credentials-reveal-meta">
              <span>{revealed.record.label}</span>
              <span>{revealed.record.kind}</span>
              <span>{revealed.record.hostRef || "-"}</span>
              <span>{revealed.record.scopeRef}</span>
            </div>
            <Input.TextArea className="credentials-secret" rows={5} value={revealed.value} readOnly />
            <Button icon={<Copy size={15} />} onClick={() => void copyValue(revealed.value)}>{t("credentials.copy")}</Button>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}

function optionalText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
