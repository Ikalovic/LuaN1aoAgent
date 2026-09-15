import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Drawer, Empty, Input, Space, Spin, Table, Tag, Typography, type TableColumnsType } from "antd";
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
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
export function EnvConfigDrawer({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useLanguage();
  const [view, setView] = useState<EnvConfigView>();
  const [loading, setLoading] = useState(false);
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
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

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
      if (!seen.has(key)) result.push({ key, sensitive: false, value, state: "new" });
    }
    return result;
  }, [pendingRemove, pendingSet, view]);

  const changeCount = Object.keys(pendingSet).length + pendingRemove.length;

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
    setFormError(undefined);
    setSavedNotice(false);
  };
  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const next = await updateEnvConfig({ set: pendingSet, remove: pendingRemove });
      setView(next);
      setPendingSet({});
      setPendingRemove([]);
      setEditingKey(undefined);
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
        placeholder: t("env.editValuePlaceholder"),
        onChange: (event: { target: { value: string } }) => setEditValue(event.target.value),
        onPressEnter: () => applyEdit(row)
      };
      return row.sensitive ? <Input.Password {...common} /> : <Input {...common} />;
    }
    const text = row.sensitive && (row.state === "saved" || row.state === "removed")
      ? row.preview || t("env.emptyValue")
      : row.value || t("env.emptyValue");
    return <span className="env-row-value">{text}</span>;
  };
  const renderActions = (row: EnvRow) => {
    if (row.state === "removed") {
      return (
        <Button type="link" size="small" icon={<RotateCcw size={13} />} onClick={() => restoreRow(row)}>
          {t("env.restore")}
        </Button>
      );
    }
    if (editingKey === row.key) {
      return (
        <>
          <Button type="link" size="small" onClick={() => applyEdit(row)}>{t("env.confirmEdit")}</Button>
          <Button type="link" size="small" onClick={cancelEdit}>{t("env.cancelEdit")}</Button>
        </>
      );
    }
    return (
      <>
        <Button type="link" size="small" icon={<Pencil size={13} />} onClick={() => startEdit(row)}>{t("env.edit")}</Button>
        <Button type="link" size="small" danger icon={<Trash2 size={13} />} onClick={() => removeRow(row)}>{t("env.remove")}</Button>
      </>
    );
  };

  const columns: TableColumnsType<EnvRow> = [
    {
      title: t("env.columnKey"),
      dataIndex: "key",
      key: "key",
      width: 230,
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
      width: 156,
      render: (_, row) => renderActions(row)
    }
  ];

  return (
    <Drawer
      className="env-drawer"
      title={t("env.title")}
      open={open}
      onClose={onClose}
      width={660}
      maskClosable={false}
    >
      <div className="env-drawer-body">
        <Alert type="info" showIcon title={t("env.description")} description={t("env.sensitiveHint")} />
        {savedNotice ? <Alert type="success" showIcon title={t("env.saveSuccess")} /> : null}
        {saveError ? <Alert type="error" showIcon title={saveError} /> : null}
        {formError ? <Alert type="warning" showIcon title={formError} /> : null}
        {loadError ? (
          <Alert
            type="error"
            showIcon
            title={t("env.loadFailed")}
            description={loadError}
            action={<Button size="small" onClick={() => void load()}>{t("env.reload")}</Button>}
          />
        ) : loading && !view ? (
          <div className="env-drawer-loading"><Spin /></div>
        ) : (
          <>
            <Table<EnvRow>
              className="env-drawer-table"
              columns={columns}
              dataSource={rows}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: 600, y: 420 }}
              rowClassName={(row) => row.state === "removed" ? "env-row-removed" : ""}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("env.noEntries")} /> }}
            />
            <div className="env-drawer-add">
              <Input
                placeholder={t("env.keyPlaceholder")}
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
              />
              <Input
                placeholder={t("env.valuePlaceholder")}
                value={newValue}
                onChange={(event) => setNewValue(event.target.value)}
                onPressEnter={addEntry}
              />
              <Button icon={<Plus size={15} />} onClick={addEntry}>{t("env.addEntry")}</Button>
            </div>
          </>
        )}
        <div className="env-drawer-footer">
          <Space>
            {changeCount ? <span className="env-change-count">{t("env.changesCount", { value: changeCount })}</span> : null}
            <Button disabled={!changeCount || saving} onClick={discardChanges}>{t("env.discard")}</Button>
            <Button type="primary" loading={saving} disabled={!changeCount} onClick={() => void save()}>
              {t("env.saveChanges")}
            </Button>
          </Space>
        </div>
      </div>
    </Drawer>
  );
}
