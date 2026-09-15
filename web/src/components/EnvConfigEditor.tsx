import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Space, Spin, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import { Check, FileKey2, Pencil, Plus, RefreshCw, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { fetchEnvConfig, updateEnvConfig } from "../api";
import { useLanguage, type TranslationKey } from "../language";
import type { EnvConfigView } from "../types";

type EnvRowState = "saved" | "edited" | "new" | "removed";

type EnvRow = {
  key: string;
  sensitive: boolean;
  value?: string;
  preview?: string;
  state: EnvRowState;
};

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const stateLabelKeys: Record<EnvRowState, TranslationKey> = {
  saved: "env.stateSaved",
  edited: "env.stateEdited",
  new: "env.stateNew",
  removed: "env.stateRemoved"
};

const stateColors: Record<EnvRowState, string> = {
  saved: "default",
  edited: "orange",
  new: "blue",
  removed: "red"
};

/**
 * Admin-only editor for the project .env file. Changes are staged locally and
 * applied in one atomic request; saved values update the live process
 * environment (next registry scans and later runs), never the current run.
 */
export function EnvConfigEditor({ active = true, compact = false, onSaved, onDirtyChange }: {
  active?: boolean;
  compact?: boolean;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useLanguage();
  const [view, setView] = useState<EnvConfigView>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [savedNotice, setSavedNotice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingSet, setPendingSet] = useState<Record<string, string>>({});
  const [pendingRemove, setPendingRemove] = useState<string[]>([]);
  const [editingKey, setEditingKey] = useState<string>();
  const [editValue, setEditValue] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const next = await fetchEnvConfig(signal);
      if (!signal?.aborted) {
        setView(next);
        setPendingSet({});
        setPendingRemove([]);
        setEditingKey(undefined);
        setEditValue("");
        setNewKey("");
        setNewValue("");
        setFormError(undefined);
        setSaveError(undefined);
        setSavedNotice(false);
      }
    } catch (cause) {
      if (!signal?.aborted) setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [active, load]);

  const rows = useMemo<EnvRow[]>(() => {
    const result: EnvRow[] = [];
    const seen = new Set<string>();
    for (const entry of view?.entries ?? []) {
      seen.add(entry.key);
      if (pendingRemove.includes(entry.key)) {
        result.push({ key: entry.key, sensitive: entry.sensitive, value: entry.value, preview: entry.preview, state: "removed" });
      } else if (Object.hasOwn(pendingSet, entry.key)) {
        result.push({ key: entry.key, sensitive: entry.sensitive, value: pendingSet[entry.key], state: "edited" });
      } else {
        result.push({ key: entry.key, sensitive: entry.sensitive, value: entry.value, preview: entry.preview, state: "saved" });
      }
    }
    for (const [key, value] of Object.entries(pendingSet)) {
      if (!seen.has(key)) result.push({ key, sensitive: true, value, state: "new" });
    }
    return result;
  }, [pendingRemove, pendingSet, view]);

  const changeCount = Object.keys(pendingSet).length + pendingRemove.length;
  const hasUnappliedInput = editingKey !== undefined || Boolean(newKey || newValue);
  const hasDraft = changeCount > 0 || hasUnappliedInput;
  const visibleRows = rows.filter((row) => row.key.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    onDirtyChange?.(active && hasDraft);
    return () => onDirtyChange?.(false);
  }, [active, hasDraft, onDirtyChange]);

  useEffect(() => {
    if (!active || !hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, hasDraft]);

  const startEdit = (row: EnvRow) => {
    setEditingKey(row.key);
    setEditValue(row.sensitive ? "" : row.value ?? "");
    setFormError(undefined);
    setSavedNotice(false);
  };
  const cancelEdit = () => {
    setEditingKey(undefined);
    setEditValue("");
  };
  const applyEdit = (row: EnvRow) => {
    if (saving) return;
    const value = editValue.trim();
    if (!value) {
      setFormError(t("env.emptyValueNotAllowed"));
      return;
    }
    setPendingSet((current) => ({ ...current, [row.key]: value }));
    setPendingRemove((current) => current.filter((key) => key !== row.key));
    setFormError(undefined);
    setSavedNotice(false);
    setEditingKey(undefined);
    setEditValue("");
  };
  const removeRow = (row: EnvRow) => {
    if (editingKey === row.key) cancelEdit();
    if (row.state === "edited" || row.state === "new") {
      setPendingSet((current) => {
        const next = { ...current };
        delete next[row.key];
        return next;
      });
      return;
    }
    setPendingRemove((current) => current.includes(row.key) ? current : [...current, row.key]);
    setSavedNotice(false);
  };
  const restoreRow = (row: EnvRow) => {
    setPendingRemove((current) => current.filter((key) => key !== row.key));
    setSavedNotice(false);
  };
  const addEntry = () => {
    if (saving || editingKey !== undefined) return;
    const key = newKey.trim();
    if (!KEY_PATTERN.test(key)) {
      setFormError(t("env.invalidKey"));
      return;
    }
    const value = newValue.trim();
    if (!value) {
      setFormError(t("env.emptyValueNotAllowed"));
      return;
    }
    setPendingSet((current) => ({ ...current, [key]: value }));
    setPendingRemove((current) => current.filter((candidate) => candidate !== key));
    setNewKey("");
    setNewValue("");
    setFormError(undefined);
    setSavedNotice(false);
  };
  const discardChanges = () => {
    setPendingSet({});
    setPendingRemove([]);
    setEditingKey(undefined);
    setEditValue("");
    setNewKey("");
    setNewValue("");
    setFormError(undefined);
    setSaveError(undefined);
    setSavedNotice(false);
  };
  const save = async () => {
    if (saving || !changeCount || hasUnappliedInput) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const next = await updateEnvConfig({ set: pendingSet, remove: pendingRemove });
      setView(next);
      setPendingSet({});
      setPendingRemove([]);
      setEditingKey(undefined);
      setEditValue("");
      setSavedNotice(true);
      setFormError(undefined);
      onSaved?.();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const renderValueCell = (row: EnvRow) => {
    if (editingKey === row.key) {
      const common = {
        size: "small" as const,
        autoFocus: true,
        value: editValue,
        disabled: saving,
        autoComplete: "off",
        "aria-label": t("env.editValuePlaceholder"),
        placeholder: t("env.editValuePlaceholder"),
        onChange: (event: { target: { value: string } }) => setEditValue(event.target.value),
        onPressEnter: () => applyEdit(row)
      };
      return row.sensitive ? <Input.Password {...common} /> : <Input {...common} />;
    }
    const text = row.sensitive
      ? (row.state === "saved" || row.state === "removed" ? row.preview || t("env.emptyValue") : "********")
      : row.value || t("env.emptyValue");
    return <span className="env-row-value">{text}</span>;
  };
  const renderActions = (row: EnvRow) => {
    const locked = saving || (editingKey !== undefined && editingKey !== row.key);
    if (row.state === "removed") {
      return (
        <Tooltip title={t("env.restore")}><Button type="text" size="small" aria-label={t("env.restore")} disabled={locked} icon={<RotateCcw size={15} />} onClick={() => restoreRow(row)} /></Tooltip>
      );
    }
    if (editingKey === row.key) {
      return (
        <Space size={4}>
          <Tooltip title={t("env.confirmEdit")}><Button type="text" size="small" aria-label={t("env.confirmEdit")} disabled={saving} icon={<Check size={15} />} onClick={() => applyEdit(row)} /></Tooltip>
          <Tooltip title={t("env.cancelEdit")}><Button type="text" size="small" aria-label={t("env.cancelEdit")} disabled={saving} icon={<X size={15} />} onClick={cancelEdit} /></Tooltip>
        </Space>
      );
    }
    return (
      <Space size={4}>
        <Tooltip title={t("env.edit")}><Button type="text" size="small" aria-label={t("env.edit")} disabled={locked} icon={<Pencil size={15} />} onClick={() => startEdit(row)} /></Tooltip>
        <Tooltip title={t(row.state === "edited" ? "env.restore" : "env.remove")}><Button type="text" size="small" danger={row.state !== "edited"} disabled={locked} aria-label={t(row.state === "edited" ? "env.restore" : "env.remove")} icon={row.state === "edited" ? <RotateCcw size={15} /> : <Trash2 size={15} />} onClick={() => removeRow(row)} /></Tooltip>
      </Space>
    );
  };

  const columns: TableColumnsType<EnvRow> = [
    {
      title: t("env.columnKey"),
      dataIndex: "key",
      key: "key",
      width: compact ? 200 : 300,
      render: (_, row) => <Typography.Text className="env-row-key" code>{row.key}</Typography.Text>
    },
    {
      title: t("env.columnValue"),
      key: "value",
      render: (_, row) => renderValueCell(row)
    },
    {
      title: t("env.columnState"),
      key: "state",
      width: 92,
      align: "center",
      render: (_, row) => <Tag color={stateColors[row.state]}>{t(stateLabelKeys[row.state])}</Tag>
    },
    {
      title: t("env.columnActions"),
      key: "actions",
      width: 96,
      fixed: "right",
      render: (_, row) => renderActions(row)
    }
  ];

  return (
      <div className={"env-drawer-body env-editor" + (compact ? " env-editor-compact" : " env-editor-page")}>
        <div className="env-editor-toolbar">
          <div className="env-editor-source"><FileKey2 size={17} /><code>{view?.path ?? ".env"}</code>{view ? <Tag>{t("env.entriesCount", { value: rows.length })}</Tag> : null}</div>
          <div className="env-editor-tools">
            <Input aria-label={t("env.search")} placeholder={t("env.search")} prefix={<Search size={15} />} allowClear value={query} disabled={saving || editingKey !== undefined} onChange={(event) => setQuery(event.target.value)} />
            <Tooltip title={t("env.reload")}><Button aria-label={t("env.reload")} disabled={loading || saving || hasDraft} icon={<RefreshCw size={15} />} onClick={() => void load()} /></Tooltip>
          </div>
        </div>
        <Alert type="info" showIcon title={t("env.description")} />
        {savedNotice ? <Alert type="success" showIcon title={t("env.saveSuccess")} /> : null}
        {saveError ? <Alert type="error" showIcon title={saveError} /> : null}
        {formError ? <Alert type="warning" showIcon title={formError} /> : null}
        {loadError ? (
          <Alert
            type="error"
            showIcon
            title={t("env.loadFailed")}
            description={loadError}
          />
        ) : loading ? (
          <div className="env-drawer-loading"><Spin /></div>
        ) : (
          <>
            <Table<EnvRow>
              className="env-drawer-table"
              columns={columns}
              dataSource={visibleRows}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: compact ? 600 : 800, y: compact ? 420 : "min(54dvh, 640px)" }}
              rowClassName={(row) => row.state === "removed" ? "env-row-removed" : ""}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(query.trim() ? "env.noMatches" : "env.noEntries")} /> }}
            />
            <div className="env-drawer-add">
              <Input
                aria-label={t("env.columnKey")}
                placeholder={t("env.keyPlaceholder")}
                autoComplete="off"
                disabled={saving || editingKey !== undefined}
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
              />
              <Input.Password
                aria-label={t("env.columnValue")}
                placeholder={t("env.valuePlaceholder")}
                autoComplete="new-password"
                disabled={saving || editingKey !== undefined}
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
                onPressEnter={addEntry}
              />
              <Button disabled={saving || editingKey !== undefined} icon={<Plus size={15} />} onClick={addEntry}>{t("env.addEntry")}</Button>
            </div>
          </>
        )}
        <div className="env-drawer-footer">
          <span className="env-editor-status">{hasUnappliedInput ? t("env.unappliedInput") : t("env.sensitiveHint")}</span>
          <Space wrap>
            {changeCount ? <span className="env-change-count">{t("env.changesCount", { value: changeCount })}</span> : null}
            <Button icon={<RotateCcw size={15} />} disabled={!hasDraft || saving} onClick={discardChanges}>{t("env.discard")}</Button>
            <Button type="primary" icon={<Save size={15} />} loading={saving} disabled={!changeCount || hasUnappliedInput} onClick={() => void save()}>
              {t("env.saveChanges")}
            </Button>
          </Space>
        </div>
      </div>
  );
}
