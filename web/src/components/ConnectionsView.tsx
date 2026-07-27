import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Empty, Popconfirm, Space, Tag, Tooltip, Typography } from "antd";
import { ExternalLink, Pause, RefreshCw, Trash2 } from "lucide-react";
import { fetchConnections, mutateRoute } from "../api";
import { useLanguage } from "../language";
import type { AuthUser, ConnectionItem } from "../types";
import { statusLabel } from "../utils";

export function ConnectionsView({ runtimeDir, user }: { runtimeDir: string; user: AuthUser }) {
  const { locale, t, formatRelative } = useLanguage();
  const [items, setItems] = useState<ConnectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [mutating, setMutating] = useState<string>();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    setItems([]);
    try {
      const response = await fetchConnections(runtimeDir, signal);
      if (!signal?.aborted) setItems(response.connections);
    } catch (cause) {
      if (!signal?.aborted) {
        setItems([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtimeDir]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const changeState = async (item: ConnectionItem, action: "stop" | "reconnect" | "forget") => {
    setMutating(`${item.id}:${action}`);
    setError(undefined);
    try {
      const updated = await mutateRoute(runtimeDir, item.id, action);
      setItems((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(undefined);
    }
  };

  return (
    <div className="connections-view">
      <div className="connections-toolbar">
        <div>
          <Typography.Title level={5}>{t("nav.connections")}</Typography.Title>
          <span>{t("connections.description")}</span>
        </div>
        <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>{t("common.refresh")}</Button>
      </div>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {!loading && !items.length ? <Empty description={t("connections.empty")} /> : null}
      <div className="connection-grid">
        {items.map((item) => (
          <Card key={item.id} className="connection-card" size="small">
            <div className="connection-card-heading">
              <div><Typography.Text strong>{item.externalId}</Typography.Text><span>{item.kind}</span></div>
              <Badge status={statusBadge(item.observedState)} text={statusLabel(item.observedState, locale)} />
            </div>
            <div className="connection-tags">
              <Tag>{item.direction}</Tag><Tag>{item.transport}</Tag>
              <Tag color={item.managed ? "blue" : "default"}>{t(item.managed ? "connections.managed" : "connections.unmanaged")}</Tag>
              {item.desiredState ? <Tag>{t("connections.desired")}: {statusLabel(item.desiredState, locale)}</Tag> : null}
              <Tag color={item.available ? "green" : "default"}>{t(item.available ? "connections.available" : "connections.unavailable")}</Tag>
            </div>
            <dl className="connection-facts">
              <div><dt>{t("connections.heartbeat")}</dt><dd>{formatRelative(item.lastHeartbeat)}</dd></div>
              <div><dt>{t("connections.error")}</dt><dd>{item.error || "—"}</dd></div>
              {item.routeRef ? <div><dt>Route</dt><dd><code>{item.routeRef}</code></dd></div> : null}
              {item.connectionRef ? <div><dt>Connection</dt><dd><code>{item.connectionRef}</code></dd></div> : null}
              {item.sessionRef && item.sessionRef !== item.connectionRef ? <div><dt>Session</dt><dd><code>{item.sessionRef}</code></dd></div> : null}
            </dl>
            <Space wrap>
              {user.role === "admin" && item.managed ? (
                <>
                  {item.actions?.includes("reconnect") ? <Button size="small" icon={<RefreshCw size={14} />} loading={mutating === `${item.id}:reconnect`} onClick={() => void changeState(item, "reconnect")}>{t("connections.reconnect")}</Button> : null}
                  {item.actions?.includes("stop") ? <Button size="small" icon={<Pause size={14} />} loading={mutating === `${item.id}:stop`} disabled={item.desiredState === "stopped"} onClick={() => void changeState(item, "stop")}>{t("common.stop")}</Button> : null}
                  {item.actions?.includes("forget") ? (
                    <Popconfirm title={t("connections.forgetConfirm")} onConfirm={() => void changeState(item, "forget")}>
                      <Button size="small" danger icon={<Trash2 size={14} />} loading={mutating === `${item.id}:forget`}>{t("connections.forget")}</Button>
                    </Popconfirm>
                  ) : null}
                </>
              ) : null}
              {item.graphUrl ? <Tooltip title={t("connections.viewGraph")}><Button size="small" href={item.graphUrl} icon={<ExternalLink size={14} />}>{t("connections.graph")}</Button></Tooltip> : null}
            </Space>
          </Card>
        ))}
      </div>
    </div>
  );
}

function statusBadge(status: ConnectionItem["observedState"]): "success" | "processing" | "warning" | "error" | "default" {
  if (status === "live") return "success";
  if (status === "degraded") return "error";
  if (status === "stale") return "warning";
  return "default";
}
