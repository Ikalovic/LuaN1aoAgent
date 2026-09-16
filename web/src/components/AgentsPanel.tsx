import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import { RefreshCw, Search, Settings } from "lucide-react";
import { fetchSpecialists, setSpecialistEnabled } from "../api";
import { useLanguage } from "../language";
import type { AuthUser, RegisteredSpecialist, SpecialistRegistrySnapshot } from "../types";
import { SpecialistOptionsDrawer } from "./SpecialistOptionsDrawer";

type AgentStatusFilter = "all" | "enabled" | "disabled" | "invalid";

/**
 * Specialist Agent panel: the Agent half of the unified capabilities page.
 * Mirrors the Skills/MCP panels: runtime-independent registry, admin-gated
 * mutation, no optimistic state flips.
 */
export function AgentsPanel({ user }: { user: AuthUser }) {
  const { t } = useLanguage();
  const [snapshot, setSnapshot] = useState<SpecialistRegistrySnapshot>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AgentStatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [mutating, setMutating] = useState<string>();
  const [configuring, setConfiguring] = useState<RegisteredSpecialist>();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchSpecialists(signal);
      if (!signal?.aborted) setSnapshot(next);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const specialists = snapshot?.specialists ?? [];
  const visible = useMemo(() => specialists.filter((specialist) => {
    const haystack = `${specialist.id} ${specialist.name} ${specialist.description} ${specialist.whenToUse ?? ""}`.toLowerCase();
    const matchesQuery = haystack.includes(query.trim().toLowerCase());
    const matchesStatus = status === "all"
      || (status === "enabled" && specialist.enabled && specialist.valid)
      || (status === "disabled" && !specialist.enabled)
      || (status === "invalid" && !specialist.valid);
    return matchesQuery && matchesStatus;
  }), [query, specialists, status]);

  const changeState = async (specialist: RegisteredSpecialist, enabled: boolean) => {
    setMutating(specialist.id);
    setError(undefined);
    try {
      const updated = await setSpecialistEnabled(specialist.id, enabled);
      setSnapshot((current) => current ? {
        ...current,
        specialists: current.specialists.map((candidate) => candidate.id === updated.id ? updated : candidate)
      } : current);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(undefined);
    }
  };

  const columns: TableColumnsType<RegisteredSpecialist> = [
    {
      title: t("agents.columnAgent"),
      dataIndex: "id",
      key: "id",
      width: 180,
      render: (id: string, specialist) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong code>{id}</Typography.Text>
          <Typography.Text type="secondary" className="agents-name">{specialist.name}</Typography.Text>
        </Space>
      )
    },
    {
      title: t("agents.columnDescription"),
      dataIndex: "description",
      key: "description",
      render: (description: string, specialist) => (
        <div className="agents-description">
          <span>{description}</span>
          {specialist.whenToUse ? <small>{specialist.whenToUse}</small> : null}
        </div>
      )
    },
    {
      title: t("agents.columnSource"),
      key: "source",
      width: 110,
      render: (_, specialist) => (
        <Space direction="vertical" size={2}>
          <Tag color={specialist.source === "builtin" ? "blue" : "purple"}>
            {specialist.source === "builtin" ? t("agents.sourceBuiltin") : t("agents.sourceProject")}
          </Tag>
          <Tag color={specialist.executability === "module" ? "orange" : "default"}>
            {specialist.executability === "module" ? t("agents.execModule") : t("agents.execPrompt")}
          </Tag>
        </Space>
      )
    },
    {
      title: t("agents.columnCapabilities"),
      key: "capabilities",
      width: 220,
      render: (_, specialist) => (
        <Space direction="vertical" size={2} className="agents-capabilities">
          <Tooltip title={specialist.disabledGroups.length > 0
            ? `${t("agents.disabledGroups")}: ${specialist.disabledGroups.join(", ")}`
            : t("agents.allToolGroups")}
          >
            <Tag color={specialist.disabledGroups.length > 0 ? "gold" : "green"}>
              {t("agents.toolGroups", { value: specialist.enabledGroups.length })}
            </Tag>
          </Tooltip>
          <Tag>{t("agents.skillMode", { value: specialist.skillMode })}</Tag>
          <Tooltip title={t("agents.authorFixedTooltip")}>
            <Typography.Text type="secondary" className="agents-author-fixed">
              {t("agents.optionAuthorFixed")}
            </Typography.Text>
          </Tooltip>
        </Space>
      )
    },
    {
      title: t("agents.columnBudget"),
      key: "budget",
      width: 190,
      render: (_, specialist) => (
        <Tooltip title={t("agents.budgetTooltip", {
          share: Math.round(specialist.budget.epochTimeShare * 100),
          concurrency: specialist.concurrency?.maxParallelTasks ?? t("agents.unbounded")
        })}
        >
          <div className="agents-budget-cell">
            <span className="agents-budget">
              {t("agents.budgetSummary", {
                turns: specialist.budget.defaultMaxTurns,
                ceiling: specialist.budget.maxTurnsCeiling,
                slice: specialist.budget.epochTurnSlice
              })}
            </span>
            <Typography.Text type="secondary" className="agents-author-fixed">
              {t("agents.optionAuthorFixed")}
            </Typography.Text>
          </div>
        </Tooltip>
      )
    },
    {
      title: t("agents.columnEnabled"),
      key: "enabled",
      width: 92,
      align: "center",
      render: (_, specialist) => {
        const reason = user.role !== "admin"
          ? t("agents.operatorRequired")
          : !specialist.valid
            ? t("agents.invalidState")
            : specialist.id === "general"
              ? t("agents.requiredState")
              : undefined;
        return (
          <Tooltip title={reason}>
            <span>
              <Switch
                aria-label={specialist.id}
                checked={specialist.enabled}
                disabled={Boolean(reason) || mutating === specialist.id}
                loading={mutating === specialist.id}
                onChange={(enabled) => void changeState(specialist, enabled)}
              />
            </span>
          </Tooltip>
        );
      }
    },
    {
      title: t("agents.columnOptions"),
      key: "options",
      width: 96,
      align: "center",
      render: (_, specialist) => {
        const hint = specialist.options.length === 0
          ? t("agents.noOptions")
          : specialist.options.some((option) => !option.editable)
            ? t("agents.optionsPartlyFixed")
            : undefined;
        return (
          <Tooltip title={hint}>
            <Button
              size="small"
              icon={<Settings size={14} />}
              aria-label={`${t("agents.optionsTitle")} ${specialist.id}`}
              disabled={user.role !== "admin" || specialist.options.length === 0 || !specialist.introspected}
              onClick={() => setConfiguring(specialist)}
            >
              {t("agents.optionsButton")}
            </Button>
          </Tooltip>
        );
      }
    }
  ];

  return (
    <div className="agents-view">
      <div className="agents-summary">
        <span>{t("agents.total", { value: specialists.length })}</span>
        <span>{t("agents.enabled", { value: specialists.filter((specialist) => specialist.enabled && specialist.valid).length })}</span>
        <span>{t("agents.invalid", { value: specialists.filter((specialist) => !specialist.valid).length })}</span>
        <span>{t("agents.diagnostics", { value: snapshot?.diagnostics.length ?? 0 })}</span>
      </div>
      <div className="agents-toolbar">
        <div>
          <Typography.Title level={5}>{t("agents.panelTitle")}</Typography.Title>
          <span>{t("agents.panelDescription")}</span>
        </div>
        <div className="agents-toolbar-controls">
          <Input
            allowClear
            prefix={<Search size={15} />}
            placeholder={t("agents.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select<AgentStatusFilter>
            aria-label={t("agents.filterLabel")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: t("agents.filterAll") },
              { value: "enabled", label: t("agents.filterEnabled") },
              { value: "disabled", label: t("agents.filterDisabled") },
              { value: "invalid", label: t("agents.filterInvalid") }
            ]}
          />
          <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>{t("agents.refresh")}</Button>
        </div>
      </div>
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void load()}>{t("agents.retry")}</Button>} /> : null}
      {snapshot?.diagnostics.length ? (
        <Alert
          className="agents-diagnostics"
          type="warning"
          showIcon
          title={t("agents.registryDiagnostics", { value: snapshot.diagnostics.length })}
          description={snapshot.diagnostics.map((diagnostic) => (
            <div key={`${diagnostic.code}:${diagnostic.specialistId ?? diagnostic.message}`}>{diagnostic.message}</div>
          ))}
        />
      ) : null}
      {loading && !snapshot ? <div className="agents-loading"><Spin /></div> : !specialists.length ? (
        <Empty description={t("agents.empty")} />
      ) : (
        <Table<RegisteredSpecialist>
          className="agents-table"
          columns={columns}
          dataSource={visible}
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1100 }}
          locale={{ emptyText: t("agents.noMatches") }}
        />
      )}
      {user.role !== "admin" ? <span className="agents-readonly-note">{t("agents.readOnly")}</span> : null}
      <SpecialistOptionsDrawer
        specialist={configuring}
        onClose={() => setConfiguring(undefined)}
        onSaved={(updated) => {
          setSnapshot((current) => current ? {
            ...current,
            specialists: current.specialists.map((candidate) => candidate.id === updated.id ? updated : candidate)
          } : current);
          void load();
        }}
      />
    </div>
  );
}
