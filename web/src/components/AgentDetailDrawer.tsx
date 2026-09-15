import { useMemo } from "react";
import { Badge, Button, Drawer, Empty, Tag, Typography } from "antd";
import { Activity, Clock3 } from "lucide-react";
import { useLanguage, type TranslationKey } from "../language";
import type { AgentEvent, TraceItem } from "../types";
import { formatRelative, formatTime, isRecent, roleLabel } from "../utils";
import { localizeTracePresentation } from "./TraceView";

const MAX_ACTIVITY = 30;

const DESCRIPTION_KEYS: Record<string, TranslationKey> = {
  planner: "agent.desc.planner",
  executor: "agent.desc.executor",
  observer: "agent.desc.observer",
  runtime: "agent.desc.runtime"
};

interface AgentDetailDrawerProps {
  open: boolean;
  role?: string;
  agent?: AgentEvent;
  eventCount?: number;
  traceItems: TraceItem[];
  onClose: () => void;
  onSelectTrace?: (traceId: string) => void;
}

export function AgentDetailDrawer(props: AgentDetailDrawerProps) {
  const { t, locale } = useLanguage();
  const role = props.role ?? "";
  const items = useMemo(() => props.traceItems
    .filter((item) => item.role === role)
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()), [props.traceItems, role]);
  const current = items[0];
  const activity = items.slice(1, MAX_ACTIVITY + 1);
  const active = isRecent(props.agent?.timestamp);
  const display = (value?: string) => localizeTracePresentation(value, locale);
  const summaryText = (item: TraceItem) => item.intentSource === "derived" ? display(item.summary) : item.summary;
  const describe = (item: TraceItem) => display(item.title) || display(item.eventLabel) || item.eventType;
  const descriptionKey = DESCRIPTION_KEYS[role];
  const command = current?.tool?.command ?? current?.commandDetails?.[0];

  return (
    <Drawer
      className="agent-detail-drawer"
      width={540}
      open={props.open}
      onClose={props.onClose}
      title={t("agent.detailTitle")}
      styles={{ body: { paddingTop: 12 } }}
    >
      <div className="agent-detail-body">
        <div className="agent-detail-hero">
          <Badge status={active ? "processing" : props.agent ? "default" : "warning"} />
          <div className="agent-detail-identity">
            <Typography.Title level={5}>{roleLabel(role)}</Typography.Title>
            <p>{descriptionKey ? t(descriptionKey) : ""}</p>
          </div>
          <span className={`agent-detail-state${active ? " active" : ""}`}>{active ? t("agent.activeNow") : t("agent.idle")}</span>
        </div>
        <div className="agent-detail-meta">
          <span>{t("agent.eventCount", { value: props.eventCount ?? 0 })}</span>
          <span>{t("agent.lastActive")} · {props.agent?.timestamp ? formatRelative(props.agent.timestamp) : "-"}</span>
        </div>

        <section className="agent-detail-section">
          <div className="agent-detail-section-title"><Activity size={14} />{t("agent.currentWork")}</div>
          {current ? (
            <article className="agent-current-card">
              <div className="agent-current-head">
                <Tag color="blue">{display(current.stage) || current.stage}</Tag>
                <time>{formatTime(current.timestamp)} · {formatRelative(current.timestamp)}</time>
              </div>
              <Typography.Title level={5}>{describe(current)}</Typography.Title>
              {summaryText(current) ? <p>{summaryText(current)}</p> : null}
              {current.decision ? <div className="agent-current-fact"><span>{t("agent.decision")}</span><p>{current.decision}</p></div> : null}
              {current.action ? <div className="agent-current-fact"><span>{t("inspector.action")}</span><p>{display(current.action)}</p></div> : null}
              {current.observation ? <div className="agent-current-fact"><span>{t("agent.observation")}</span><p>{current.observation}</p></div> : null}
              {command ? <div className="agent-current-command"><span>{t("agent.command")}</span><pre>{command}</pre></div> : null}
              {props.onSelectTrace ? (
                <Button size="small" type="primary" ghost onClick={() => props.onSelectTrace?.(current.id)}>{t("agent.viewInTrace")}</Button>
              ) : null}
            </article>
          ) : props.agent ? (
            <article className="agent-current-card">
              <div className="agent-current-head">
                <Tag>{props.agent.eventType || "-"}</Tag>
                <time>{formatRelative(props.agent.timestamp)}</time>
              </div>
              <p>{props.agent.summary || t("agent.noEventYet")}</p>
            </article>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("agent.noEventYet")} />
          )}
        </section>

        <section className="agent-detail-section">
          <div className="agent-detail-section-title"><Clock3 size={14} />{t("agent.recentActivity")}{activity.length ? <em>{activity.length}</em> : null}</div>
          {activity.length ? (
            <div className="agent-activity-list">
              {activity.map((item) => (
                <button
                  className="agent-activity-item"
                  key={item.id}
                  type="button"
                  onClick={() => props.onSelectTrace?.(item.id)}
                  disabled={!props.onSelectTrace}
                >
                  <span className="agent-activity-meta"><Tag>{display(item.stage) || item.stage}</Tag><time>{formatRelative(item.timestamp)}</time></span>
                  <strong>{describe(item)}</strong>
                  <small>{summaryText(item)}</small>
                </button>
              ))}
            </div>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("agent.noActivity")} />}
        </section>
      </div>
    </Drawer>
  );
}
