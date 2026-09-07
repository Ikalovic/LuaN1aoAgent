import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Empty, Modal, Popconfirm, Segmented, Spin, Tag, Typography } from "antd";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { decideApproval, fetchApprovals, updateApprovalMode } from "../api";
import { useLanguage } from "../language";
import type { ApprovalMode, ApprovalsResponse, AuthUser, PendingApproval } from "../types";

const FAST_POLL_MS = 2_000;
const IDLE_POLL_MS = 5_000;
const MODE_OPTIONS: readonly ApprovalMode[] = ["off", "auto", "strict"];

export function ApprovalsView({ user, onPendingChange }: {
  user: AuthUser;
  onPendingChange?: (count: number) => void;
}) {
  const { t, formatRelative } = useLanguage();
  const [response, setResponse] = useState<ApprovalsResponse>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [deciding, setDeciding] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const isAdmin = user.role === "admin";

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchApprovals(undefined, signal);
      if (signal?.aborted) return;
      setResponse(next);
      setError(undefined);
      onPendingChange?.(next.approvals.length);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onPendingChange]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const pendingCount = response?.approvals.length ?? 0;
    const timer = window.setInterval(() => void load(), pendingCount > 0 ? FAST_POLL_MS : IDLE_POLL_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load, response?.approvals.length]);

  const decide = async (approval: PendingApproval, decision: "approve" | "deny") => {
    setDeciding(approval.id);
    setError(undefined);
    try {
      await decideApproval(approval.id, decision);
      await load();
    } catch (cause) {
      setError(t("approvals.decideFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setDeciding(undefined);
    }
  };

  const switchMode = async (next: ApprovalMode) => {
    if (next === response?.mode) return;
    if (next === "off") {
      const confirmed = await confirmOffSwitch(t);
      if (!confirmed) return;
    }
    setSwitching(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await updateApprovalMode(next);
      setResponse((prev: ApprovalsResponse | undefined) => (prev ? { ...prev, mode: result.mode } : prev));
      setNotice(t("approvals.switchSuccess", { mode: modeLabel(result.mode, t) }));
    } catch (cause) {
      setError(t("approvals.switchFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setSwitching(false);
    }
  };

  const approvals = response?.approvals ?? [];
  return (
    <div className="approvals-view">
      <div className="approvals-summary">
        <span>{t("approvals.pendingCount", { value: approvals.length })}</span>
        {response ? isAdmin ? (
          <span className="approvals-mode-switch">
            <span className="approvals-mode-switch-label">{t("approvals.switchMode")}：</span>
            <Segmented
              size="small"
              disabled={switching}
              value={response.mode}
              options={MODE_OPTIONS.map((value) => ({ value, label: modeLabel(value, t) }))}
              onChange={(value) => void switchMode(value as ApprovalMode)}
            />
          </span>
        ) : (
          <span>{t("approvals.mode")}：{modeLabel(response.mode, t)}</span>
        ) : null}
      </div>
      {isAdmin ? <span className="approvals-live-note">{t("approvals.liveNotice")}</span> : null}
      {notice ? <Alert type="success" showIcon closable onClose={() => setNotice(undefined)} message={notice} /> : null}
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void load()}>{t("approvals.retry")}</Button>} /> : null}
      {!response && !error ? <div className="approvals-loading"><Spin /></div> : !approvals.length ? (
        <Empty description={t("approvals.empty")} />
      ) : (
        <div className="approvals-list">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              canDecide={isAdmin}
              deciding={deciding === approval.id}
              formatRelative={formatRelative}
              onDecide={(decision) => void decide(approval, decision)}
            />
          ))}
        </div>
      )}
      {!isAdmin ? <span className="approvals-readonly-note">{t("approvals.readOnly")}</span> : null}
    </div>
  );
}

function ApprovalCard({ approval, canDecide, deciding, formatRelative, onDecide }: {
  approval: PendingApproval;
  canDecide: boolean;
  deciding: boolean;
  formatRelative: (value?: string | number | Date) => string;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="approval-card">
      <div className="approval-card-header">
        <span className="approval-card-icon"><ShieldAlert size={17} /></span>
        <div className="approval-card-titles">
          <Typography.Text strong code>{approval.toolName}</Typography.Text>
          <span className="approval-card-meta">
            {riskTag(approval.riskLevel, t)} · {formatRelative(approval.createdAt)} · {approval.runtimeDir}
          </span>
        </div>
        <Tag color="processing" className="approval-card-waiting">{t("approvals.waiting")}</Tag>
      </div>
      {approval.intent ? (
        <div className="approval-card-intent">
          <span className="approval-card-label">{t("approvals.intent")}</span>
          <p>{approval.intent}</p>
        </div>
      ) : null}
      {approval.reason ? (
        <div className="approval-card-reason">
          <span className="approval-card-label">{t("approvals.reason")}</span>
          <p>{approval.reason}</p>
        </div>
      ) : null}
      <div className="approval-card-details">
        {approval.taskGoal ? <div><span className="approval-card-label">{t("approvals.task")}</span><p>{approval.taskGoal}</p></div> : null}
        {approval.scopeSummary ? <div><span className="approval-card-label">{t("approvals.scope")}</span><p>{approval.scopeSummary}</p></div> : null}
        <div>
          <span className="approval-card-label">{t("approvals.args")}</span>
          <pre className="approval-card-args">{approval.toolArgs}</pre>
        </div>
      </div>
      <div className="approval-card-actions">
        <Popconfirm
          title={t("approvals.deny")}
          description={t("approvals.requireAdmin")}
          okText={t("approvals.deny")}
          cancelText={t("common.cancel")}
          okButtonProps={{ danger: true }}
          disabled={!canDecide || deciding}
          onConfirm={() => onDecide("deny")}
        >
          <Button danger icon={<XCircle size={15} />} disabled={!canDecide || deciding} loading={deciding}>{t("approvals.deny")}</Button>
        </Popconfirm>
        <Button type="primary" icon={<CheckCircle2 size={15} />} disabled={!canDecide || deciding} loading={deciding} onClick={() => onDecide("approve")}>{t("approvals.approve")}</Button>
      </div>
    </div>
  );
}

function riskTag(riskLevel: PendingApproval["riskLevel"], t: ReturnType<typeof useLanguage>["t"]): ReactNode {
  if (riskLevel === "high") return <Tag color="red">{t("approvals.riskHigh")}</Tag>;
  if (riskLevel === "medium") return <Tag color="orange">{t("approvals.riskMedium")}</Tag>;
  return <Tag color="green">{t("approvals.riskLow")}</Tag>;
}

function modeLabel(mode: ApprovalMode, t: ReturnType<typeof useLanguage>["t"]): string {
  if (mode === "off") return t("approvals.modeOff");
  if (mode === "strict") return t("approvals.modeStrict");
  return t("approvals.modeAuto");
}

function confirmOffSwitch(t: ReturnType<typeof useLanguage>["t"]): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: t("approvals.confirmOffTitle"),
      content: t("approvals.confirmOffDesc"),
      okText: t("approvals.confirmOffTitle"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    });
  });
}
