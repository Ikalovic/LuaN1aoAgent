import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Dropdown, Input, Popconfirm, Select, Skeleton, Spin, Switch, Tooltip } from "antd";
import { LogOut, Moon, Play, RefreshCw, Square, Sun, UserRound } from "lucide-react";
import { stopRun, fetchApprovals } from "./api";
import { AgentDetailDrawer } from "./components/AgentDetailDrawer";
import { Inspector } from "./components/Inspector";
import { ConnectionsView } from "./components/ConnectionsView";
import { ApprovalsView } from "./components/ApprovalsView";
import { ArtifactsView } from "./components/ArtifactsView";
import { SkillsView } from "./components/SkillsView";
import { McpView } from "./components/McpView";
import { CredentialsView } from "./components/CredentialsView";
import { EnvConfigEditor } from "./components/EnvConfigEditor";
import { AgentsPanel } from "./components/AgentsPanel";
import { MemoryView } from "./components/MemoryView";
import { StartRunModal } from "./components/StartRunModal";
import { TraceView } from "./components/TraceView";
import { TrafficInspector } from "./components/TrafficInspector";
import { TrafficView } from "./components/TrafficView";
import { WorkbenchShell } from "./components/WorkbenchShell";
import { RunSwitcher } from "./components/RunSwitcher";
import { OverviewView } from "./components/OverviewView";
import { FindingsView } from "./components/FindingsView";
import { activityOptions } from "./components/ActivityChart";
import { projectTaskTree } from "./graph";
import { buildSituation, TASK_STATUSES } from "./situation";
import { useLanguage } from "./language";
import { useTheme } from "./ThemeProvider";
import { useWorkbenchNavigation } from "./useWorkbenchNavigation";
import type { AuthUser, RuntimeSession, TrafficExchange, GraphKind, PendingApproval } from "./types";
import { useRuntimeDashboard } from "./useRuntimeDashboard";
import { navigationUrl } from "./navigation";
const GraphView = lazy(() => import("./components/GraphView").then((module) => ({ default: module.GraphView })));
const WallboardView = lazy(() => import("./components/WallboardView"));

export default function App({ user, onLogout, onHome }: { user: AuthUser; onLogout: () => Promise<void>; onHome?: () => void }) {
  const { locale, t, toggleLocale, formatDate } = useLanguage();
  const zh = locale === "zh-CN";
  const { mode, toggleTheme } = useTheme();
  const dirty = useRef(false);
  const envDirty = useRef(false);
  const onEnvDirtyChange = useCallback((value: boolean) => { envDirty.current = value; }, []);
  const allowLeave = useCallback(() => {
    if (envDirty.current) return window.confirm(t("env.unsavedConfirm"));
    return !dirty.current || window.confirm(zh ? "放弃未提交的重放修改？" : "Discard unsent replay changes?");
  }, [zh, t]);
  const { state: navigation, navigate } = useWorkbenchNavigation(allowLeave);
  const { runtimeDir, view: activeView, nodeId: selectedNodeId, traceId: selectedTraceId, exchangeId: selectedExchangeId } = navigation;
  const [selectedExchange, setSelectedExchange] = useState<TrafficExchange>();
  const [trafficRefreshToken, setTrafficRefreshToken] = useState(0);
  const [newestFirst, setNewestFirst] = useState(false);
  const [agentDetailRole, setAgentDetailRole] = useState<string>();
  const [startRunOpen, setStartRunOpen] = useState(false);
  const [continueTarget, setContinueTarget] = useState<RuntimeSession>();
  const [stopping, setStopping] = useState(false);
  const [stopAccepted, setStopAccepted] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [pendingStartDir, setPendingStartDir] = useState<string>();
  const [approvalPendingCount, setApprovalPendingCount] = useState(0);
  const [approvalSnapshot, setApprovalSnapshot] = useState<PendingApproval[]>();
  const isAdmin = user.role === "admin";
  const globalView = ["skills", "mcp", "agents", "env", "approvals"].includes(activeView);
  const dashboard = useRuntimeDashboard(runtimeDir);
  const dataMatchesDir = dashboard.loadedRuntimeDir !== undefined && normalizeDir(dashboard.loadedRuntimeDir) === normalizeDir(runtimeDir);
  const data = dataMatchesDir ? dashboard.data : undefined;
  const situation = useMemo(() => buildSituation(data), [data]);
  const canonicalDir = data?.runtimeDir ?? runtimeDir;
  const runningNow = dashboard.activeRuns.some((run) => normalizeDir(run.runtimeDir) === normalizeDir(canonicalDir));
  const hasPlannerTrace = data?.traceItems.some((item) => item.role === "planner") ?? false;
  const initializing = !hasPlannerTrace && !dashboard.error && (runningNow || pendingStartDir === runtimeDir);
  const roleFilter = navigation.role ?? "all";
  useEffect(() => { setSelectedExchange(undefined); setStopAccepted(false); setAgentDetailRole(undefined); dirty.current = false; }, [runtimeDir]);
  useEffect(() => { if (!runningNow && dashboard.runsKnown) setStopAccepted(false); }, [runningNow, dashboard.runsKnown]);
  useEffect(() => { if (pendingStartDir && (pendingStartDir !== runtimeDir || hasPlannerTrace)) setPendingStartDir(undefined); }, [pendingStartDir, runtimeDir, hasPlannerTrace]);
  useEffect(() => {
    if (!isAdmin || activeView === "approvals" || activeView === "wallboard") return;
    let disposed = false;
    const poll = async () => { try { const next = await fetchApprovals(); if (!disposed) { setApprovalPendingCount(next.approvals.length); setApprovalSnapshot(next.approvals); } } catch { if (!disposed) setApprovalSnapshot(undefined); } };
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [isAdmin, activeView]);
  const sessions = useMemo(() => {
    const active = new Set(dashboard.activeRuns.map((run) => normalizeDir(run.runtimeDir)));
    return dashboard.sessions.map((session) => active.has(normalizeDir(session.runtimeDir)) ? { ...session, running: true } : session);
  }, [dashboard.activeRuns, dashboard.sessions]);
  const stopCurrentRun = async () => {
    setStopping(true); setActionError(undefined);
    try { await stopRun(runtimeDir); setStopAccepted(true); await dashboard.refresh(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStopping(false); }
  };
  const inspectorGraph = useMemo(() => activeView === "task" ? projectTaskTree(situation.nodes, situation.edges) : situation, [activeView, situation]);
  const selectedNode = inspectorGraph.nodes.find((node) => node.id === (selectedNodeId ?? (activeView === "task" ? navigation.taskId : undefined)));
  const selectedTrace = data?.traceItems.find((item) => item.id === selectedTraceId);
  const selectNode = (nodeId?: string) => navigate({ nodeId }, "replace");
  const selectExchange = (exchangeId?: string) => navigate({ exchangeId }, "replace");
  const onExchangeLoaded = useCallback((exchange?: TrafficExchange) => setSelectedExchange(exchange), []);
  const closeInspector = () => navigate({ nodeId: undefined, taskId: undefined, traceId: undefined, exchangeId: undefined }, "replace");
  const nodeView = ["overview", "operation", "memory", "reasoning", "task", "findings"].includes(activeView);
  const selection = activeView === "trace" ? selectedTraceId : activeView === "traffic" ? selectedExchangeId : nodeView ? selectedNodeId ?? navigation.taskId : undefined;
  const missing = selection && activeView !== "traffic" && !(activeView === "trace" ? selectedTrace : selectedNode);
  const inspector = !globalView && selection ? <>{missing ? <Alert type="warning" title={zh ? "所选记录未加载或已不存在" : "Selected record is not loaded or no longer exists"} /> : activeView === "traffic" ? <TrafficInspector key={runtimeDir + ":" + selectedExchangeId} runtimeDir={runtimeDir} exchange={selectedExchange?.id === selectedExchangeId ? selectedExchange : undefined} user={user} onDirtyChange={(value) => { dirty.current = value; }} onSelectExchange={selectExchange} onReplayed={(exchangeId) => { dirty.current = false; selectExchange(exchangeId); setTrafficRefreshToken((value) => value + 1); }} /> : <Inspector nodes={situation.nodes} traceItems={data?.traceItems ?? []} onSelectNode={(node) => navigate({ view: node.graphKind as GraphKind, nodeId: node.id })} onSelectTrace={(traceId) => navigate({ view: "trace", traceId, role: "all", range: "loaded" })} view={activeView} runtimeDir={runtimeDir} trace={selectedTrace} node={selectedNode} edges={inspectorGraph.edges} artifacts={data?.artifacts.records ?? []} tasks={data?.overview.tasks.items ?? []} agents={data?.overview.agents ?? {}} />}{selectedNode && activeView === "findings" ? <Button onClick={() => navigate({ view: "reasoning", nodeId: selectedNode.id })}>{zh ? "查看证据关系" : "View evidence graph"}</Button> : null}</> : undefined;
  const traceItems = useMemo(() => {
    const options = activityOptions(navigation, data?.loadedAt);
    const start = options.start ? Date.parse(options.start) : options.relativeMs !== undefined && data ? Date.parse(data.loadedAt) - options.relativeMs : -Infinity;
    const end = options.end ? Date.parse(options.end) : Infinity;
    return (data?.traceItems ?? []).filter((item) => (!navigation.taskId || item.taskId === navigation.taskId) && (navigation.range === "loaded" || !navigation.range || (Date.parse(item.timestamp) >= start && Date.parse(item.timestamp) <= end)));
  }, [data, navigation.range, navigation.from, navigation.to, navigation.taskId]);
  const trafficTime = useMemo(() => {
    const now = data?.loadedAt ?? new Date().toISOString();
    const options = activityOptions(navigation, now);
    return { startedAfter: options.start ?? (options.relativeMs === undefined ? undefined : new Date(Date.parse(now) - options.relativeMs).toISOString()), startedBefore: options.end ?? (options.relativeMs === undefined ? undefined : now) };
  }, [data?.loadedAt, navigation.range, navigation.from, navigation.to]);
  const currentApprovals = isAdmin ? { value: approvalSnapshot && dataMatchesDir ? approvalSnapshot.filter((item) => item.status === "pending" && normalizeDir(item.runtimeDir) === normalizeDir(canonicalDir)).length : null, state: approvalSnapshot && dataMatchesDir ? "complete" as const : "unavailable" as const } : undefined;
  if (activeView === "wallboard") return <Suspense fallback={<div style={{ background: "#090d10", color: "#f1f3f5", minHeight: "100dvh", padding: 32 }}>青玄 · 正在加载态势大屏</div>}><WallboardView dashboard={dashboard} data={data} situation={situation} navigation={navigation} onNavigate={navigate} /></Suspense>;
  const toolbar = <div className="qx-topbar-controls">
    <RunSwitcher runtimeDir={runtimeDir} sessions={sessions} onChange={(next) => navigate({ runtimeDir: next })} onContinue={setContinueTarget} />
    <Tooltip title={t("app.startTask")}><Button className="qx-start" aria-label={t("app.startTask")} icon={<Play size={16} />} onClick={() => setStartRunOpen(true)}>{t("app.startTask")}</Button></Tooltip>
    {runningNow || stopAccepted ? <Popconfirm title={t("app.stopConfirm")} description={t("app.stopDescription")} onConfirm={stopCurrentRun} okText={t("common.stop")} cancelText={t("common.cancel")}><Button danger loading={stopping} disabled={stopAccepted} icon={<Square size={15} />}>{stopAccepted ? (zh ? "正在停止" : "Stopping") : t("common.stop")}</Button></Popconfirm> : null}
    <Tooltip title={t("app.refreshRuntime")}><Button aria-label={t("app.refreshRuntime")} icon={<RefreshCw size={16} className={dashboard.refreshing ? "spin" : ""} />} onClick={() => void dashboard.refresh()} /></Tooltip>
    <label className="qx-auto-refresh"><Switch size="small" checked={dashboard.autoRefresh} onChange={dashboard.setAutoRefresh} /><span>{t("app.autoRefresh")}</span></label>
    <Tooltip title={zh ? "切换主题" : "Toggle theme"}><Button aria-label={zh ? "切换主题" : "Toggle theme"} icon={mode === "dark" ? <Sun size={17} /> : <Moon size={17} />} onClick={toggleTheme} /></Tooltip>
    <Dropdown trigger={["click"]} menu={{ items: [{ key: "identity", disabled: true, label: user.displayName + " · " + user.role }, { key: "language", label: zh ? "English" : "中文" }, { key: "refresh", label: t("app.autoRefresh") }, { key: "logout", danger: true, icon: <LogOut size={15} />, label: t("app.logout") }], onClick: ({ key }) => { if (key === "language") toggleLocale(); if (key === "refresh") dashboard.setAutoRefresh(!dashboard.autoRefresh); if (key === "logout" && allowLeave()) void onLogout(); } }}><Button icon={<UserRound size={17} />} aria-label={t("app.userMenu")} /></Dropdown>
  </div>;
  let content;
  if (activeView === "approvals") content = isAdmin ? <ApprovalsView user={user} onPendingChange={setApprovalPendingCount} /> : <Alert type="warning" title={zh ? "需要管理员权限" : "Administrator access required"} action={<Button onClick={() => navigate({ view: "overview" })}>{zh ? "返回总览" : "Back to overview"}</Button>} />;
  else if (activeView === "skills") content = <SkillsView user={user} />;
  else if (activeView === "mcp") content = <McpView user={user} />;
  else if (activeView === "agents") content = <AgentsPanel user={user} />;
  else if (activeView === "memory") content = <MemoryView key={runtimeDir} runtimeDir={runtimeDir} nodes={situation.nodes} edges={situation.edges} selectedNodeId={selectedNodeId} onSelectNode={selectNode} />;
  else if (activeView === "env") content = isAdmin ? <EnvConfigEditor onDirtyChange={onEnvDirtyChange} /> : <Alert type="warning" title={zh ? "需要管理员权限" : "Administrator access required"} action={<Button onClick={() => navigate({ view: "overview" })}>{zh ? "返回总览" : "Back to overview"}</Button>} />;
  else if (activeView === "credentials") content = isAdmin ? <CredentialsView key={runtimeDir} runtimeDir={runtimeDir} /> : <Alert type="warning" title={zh ? "需要管理员权限" : "Administrator access required"} action={<Button onClick={() => navigate({ view: "overview" })}>{zh ? "返回总览" : "Back to overview"}</Button>} />;
  else if (activeView === "connections") content = <ConnectionsView runtimeDir={runtimeDir} user={user} />;
  else if (activeView === "traffic") content = <TrafficView key={runtimeDir} runtimeDir={runtimeDir} {...trafficTime} taskId={navigation.taskId} selectedExchangeId={selectedExchangeId} refreshToken={trafficRefreshToken} onSelectExchange={selectExchange} onExchangeLoaded={onExchangeLoaded} />;
  else if (activeView === "overview") content = <OverviewView pendingApprovals={currentApprovals} situation={situation} data={data} navigation={navigation} onNavigate={navigate} onSelectNode={selectNode} onAgent={setAgentDetailRole} />;
  else if (activeView === "findings") content = <FindingsView situation={situation} type={navigation.findingType} selectedId={selectedNodeId} onTypeChange={(findingType) => navigate({ findingType }, "replace")} onSelect={selectNode} onGraph={(nodeId) => navigate({ view: "reasoning", nodeId })} />;
  else if (activeView === "reports") content = <ArtifactsView runtimeDir={runtimeDir} taskId={navigation.taskId} artifacts={data?.artifacts.records ?? []} taskOutcomes={data?.reports?.taskOutcomes ?? []} epochOutcomes={data?.reports?.epochOutcomes ?? []} latestTaskOutcome={data?.reports?.latestTaskOutcome} finalResult={data?.reports?.finalResult} finalReport={data?.reports?.finalReport} tasks={data?.overview.tasks.items ?? []} />;
  else if (activeView === "trace") content = <TraceView items={traceItems} planningCheckpoints={data?.reports?.planningRounds ?? []} taskOutcomes={data?.reports?.taskOutcomes ?? []} epochOutcomes={data?.reports?.epochOutcomes ?? []} tasks={data?.overview.tasks.items ?? []} selectedTraceId={selectedTraceId} roleFilter={roleFilter} newestFirst={newestFirst} onRoleFilterChange={(role) => navigate({ role }, "replace")} onOrderChange={() => setNewestFirst((value) => !value)} onSelectTrace={(traceId) => navigate({ traceId }, "replace")} />;
  else content = <Suspense fallback={<Skeleton active />}><GraphView onClearFilters={() => navigate({ taskStatus: undefined, nodeType: undefined }, "replace")} runtimeDir={runtimeDir} kind={activeView as GraphKind} nodes={navigation.taskStatus && activeView === "task" ? situation.nodes.filter((node) => node.type !== "Task" || (TASK_STATUSES.includes(node.properties.status as typeof TASK_STATUSES[number]) ? node.properties.status : "unknown") === navigation.taskStatus) : situation.nodes} edges={situation.edges} nodeType={navigation.nodeType} selectedNodeId={selectedNodeId ?? navigation.taskId} linkedNodeIds={selectedTrace?.graphNodeRefs ?? []} onSelectNode={selectNode} /></Suspense>;
  return <><WorkbenchShell view={activeView} onHome={onHome ? () => { if (allowLeave()) onHome(); } : undefined} wallboardUrl={navigationUrl({ runtimeDir, view: "wallboard" })} onViewChange={(view) => navigate({ view })} canApprove={isAdmin} canManageCredentials={isAdmin} canManageEnvironment={isAdmin} pendingCount={approvalPendingCount} toolbar={toolbar} inspector={inspector} onCloseInspector={closeInspector}>
    {!globalView && dashboard.error ? <Alert type="error" showIcon title={dashboard.error} /> : null}
    {actionError ? <Alert closable type="error" showIcon title={actionError} onClose={() => setActionError(undefined)} /> : null}
    {!globalView ? <section className="qx-run-context"><div><strong>{data?.overview.goal?.label || (initializing ? t("app.initializingGoal") : t("app.waitingRuntime"))}</strong>{data?.overview.scope ? <details><summary>{zh ? "范围与上下文" : "Scope & context"}</summary><p>{String(data.overview.scope.summary || data.overview.scope.label)}</p></details> : null}</div><span>{stopAccepted ? (zh ? "正在停止" : "Stopping") : runningNow ? t("app.running") : ""}{dashboard.delayed ? (zh ? " · 数据延迟" : " · Delayed") : ""}{data?.loadedAt ? " · " + formatDate(data.loadedAt) : ""}</span></section> : null}
    {!globalView && (activeView === "overview" || activeView === "trace" || activeView === "traffic") ? <div className="qx-time-filter"><Select aria-label={zh ? "活动时间" : "Activity range"} value={navigation.range ?? "loaded"} onChange={(range) => navigate({ range })} options={[{ value: "loaded", label: zh ? "全部已加载" : "All loaded" }, { value: "15m", label: "15 min" }, { value: "1h", label: "1 h" }, { value: "24h", label: "24 h" }, { value: "custom", label: zh ? "自定义" : "Custom" }]} />{navigation.range === "custom" ? <><Input type="datetime-local" aria-label="From UTC" value={navigation.from?.slice(0, 16) ?? ""} onChange={(event) => navigate({ from: event.target.value ? event.target.value + ":00Z" : undefined }, "replace")} /><Input type="datetime-local" aria-label="To UTC" value={navigation.to?.slice(0, 16) ?? ""} onChange={(event) => navigate({ to: event.target.value ? event.target.value + ":00Z" : undefined }, "replace")} /></> : null}<span>UTC</span></div> : null}
    {initializing && !globalView ? <div className="qx-initializing"><Spin size="small" /><span>{t("app.initializingTitle")}</span></div> : null}
    <section className={"qx-view qx-view-" + activeView}>{content}</section>
  </WorkbenchShell>
  <AgentDetailDrawer open={Boolean(agentDetailRole)} role={agentDetailRole} agent={agentDetailRole ? data?.overview.agents[agentDetailRole] : undefined} eventCount={agentDetailRole ? data?.overview.events.byRole[agentDetailRole] : undefined} traceItems={data?.traceItems ?? []} onClose={() => setAgentDetailRole(undefined)} onSelectTrace={(traceId) => { navigate({ view: "trace", traceId, role: agentDetailRole }); setAgentDetailRole(undefined); }} />
  <StartRunModal open={startRunOpen || Boolean(continueTarget)} continueFrom={continueTarget ? { runtimeDir: continueTarget.runtimeDir, goal: continueTarget.goal ?? "", scopeSummary: continueTarget.scopeSummary, taskType: continueTarget.taskType } : undefined} onClose={() => { setStartRunOpen(false); setContinueTarget(undefined); }} onStarted={(dir) => { setStartRunOpen(false); setContinueTarget(undefined); setPendingStartDir(dir); navigate({ runtimeDir: dir }); }} /></>;
}
function normalizeDir(value: string): string { return value.replace(/\/+$/, "") || ".agent-runtime"; }
