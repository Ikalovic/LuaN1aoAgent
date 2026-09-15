import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Select, Spin, Switch, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import { RefreshCw, Search, Settings } from "lucide-react";
import { fetchMcpServers, setMcpEnabled } from "../api";
import { useLanguage } from "../language";
import type { AuthUser, McpRegistrySnapshot, RegisteredMcpServer } from "../types";
import { EnvConfigDrawer } from "./EnvConfigDrawer";

type McpStatusFilter = "all" | "enabled" | "disabled" | "unconfigured";

export function McpView({ user }: { user: AuthUser }) {
  const { t } = useLanguage();
  const [snapshot, setSnapshot] = useState<McpRegistrySnapshot>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<McpStatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [mutating, setMutating] = useState<string>();
  const [envOpen, setEnvOpen] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchMcpServers(signal);
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

  const servers = snapshot?.servers ?? [];
  const visible = useMemo(() => servers.filter((server) => {
    const matchesQuery = `${server.name} ${server.description} ${server.tools.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesStatus = status === "all"
      || (status === "enabled" && server.enabled)
      || (status === "disabled" && !server.enabled)
      || (status === "unconfigured" && !server.configured);
    return matchesQuery && matchesStatus;
  }), [query, servers, status]);
  const changeState = async (server: RegisteredMcpServer, enabled: boolean) => {
    setMutating(server.name);
    setError(undefined);
    try {
      const updated = await setMcpEnabled(server.name, enabled);
      setSnapshot((current) => current ? {
        ...current,
        servers: current.servers.map((candidate) => candidate.name === updated.name ? updated : candidate)
      } : current);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(undefined);
    }
  };
  const columns: TableColumnsType<RegisteredMcpServer> = [
    {
      title: "MCP",
      dataIndex: "name",
      key: "name",
      width: 150,
      render: (name: string) => <Typography.Text strong code>{name}</Typography.Text>
    },
    {
      title: t("mcp.columnDescription"),
      dataIndex: "description",
      key: "description",
      render: (description: string) => <span className="mcp-description">{description}</span>
    },
    {
      title: t("mcp.columnTools"),
      key: "tools",
      width: 110,
      align: "center",
      render: (_, server) => (
        <Tooltip title={server.tools.join(", ")}>
          <Tag color="geekblue">{t("mcp.toolsCount", { value: server.tools.length })}</Tag>
        </Tooltip>
      )
    },
    {
      title: t("mcp.columnConfigured"),
      key: "configured",
      width: 110,
      render: (_, server) => <Tag color={server.configured ? "green" : "red"}>{server.configured ? t("mcp.configured") : t("mcp.notConfigured")}</Tag>
    },
    {
      title: t("mcp.columnEnabled"),
      key: "enabled",
      width: 88,
      align: "center",
      render: (_, server) => {
        const reason = user.role !== "admin"
          ? t("mcp.operatorRequired")
          : !server.configured
            ? t("mcp.notConfiguredState")
            : undefined;
        return (
          <Tooltip title={reason}>
            <span>
              <Switch
                aria-label={server.name}
                checked={server.enabled}
                disabled={Boolean(reason) || mutating === server.name}
                loading={mutating === server.name}
                onChange={(enabled) => void changeState(server, enabled)}
              />
            </span>
          </Tooltip>
        );
      }
    }
  ];

  return (
    <div className="mcp-view">
      <div className="mcp-summary">
        <span>{t("mcp.total", { value: servers.length })}</span>
        <span>{t("mcp.enabled", { value: servers.filter((server) => server.enabled).length })}</span>
        <span>{t("mcp.unconfigured", { value: servers.filter((server) => !server.configured).length })}</span>
        <span>{t("mcp.diagnostics", { value: snapshot?.diagnostics.length ?? 0 })}</span>
      </div>
      <div className="mcp-toolbar">
        <div>
          <Typography.Title level={5}>MCP</Typography.Title>
          <span>{t("mcp.description")}</span>
        </div>
        <div className="mcp-toolbar-controls">
          <Input
            allowClear
            prefix={<Search size={15} />}
            placeholder={t("mcp.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select<McpStatusFilter>
            aria-label={t("mcp.filterLabel")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: t("mcp.filterAll") },
              { value: "enabled", label: t("mcp.filterEnabled") },
              { value: "disabled", label: t("mcp.filterDisabled") },
              { value: "unconfigured", label: t("mcp.filterUnconfigured") }
            ]}
          />
          <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>{t("mcp.refresh")}</Button>
          {user.role === "admin" ? (
            <Button icon={<Settings size={15} />} onClick={() => setEnvOpen(true)}>{t("env.open")}</Button>
          ) : null}
        </div>
      </div>
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void load()}>{t("mcp.retry")}</Button>} /> : null}
      {snapshot?.diagnostics.length ? (
        <Alert
          className="mcp-diagnostics"
          type="warning"
          showIcon
          title={t("mcp.registryDiagnostics", { value: snapshot.diagnostics.length })}
          description={snapshot.diagnostics.map((diagnostic) => <div key={`${diagnostic.code}:${diagnostic.serverName ?? diagnostic.message}`}>{diagnostic.message}</div>)}
        />
      ) : null}
      {loading && !snapshot ? <div className="mcp-loading"><Spin /></div> : !servers.length ? (
        <Empty description={t("mcp.empty")} />
      ) : (
        <Table<RegisteredMcpServer>
          className="mcp-table"
          columns={columns}
          dataSource={visible}
          rowKey="name"
          pagination={false}
          size="small"
          scroll={{ x: 780 }}
          locale={{ emptyText: t("mcp.noMatches") }}
        />
      )}
      {user.role !== "admin" ? <span className="mcp-readonly-note">{t("mcp.readOnly")}</span> : null}
      {user.role === "admin" ? (
        <EnvConfigDrawer open={envOpen} onClose={() => setEnvOpen(false)} onSaved={() => void load()} />
      ) : null}
    </div>
  );
}
