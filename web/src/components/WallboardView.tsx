import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select, Tooltip } from "antd";
import { ArrowUpRight, Database, Globe, Layers, Server, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { FixedDarkTheme } from "../ThemeProvider";
import { assetValidation, hasFindingEvidence, projectGraph, type CountMetric, type Situation } from "../situation";
import { projectTaskTree } from "../graph";
import { navigationUrl, type NavigationState } from "../navigation";
import { useWallboardPresentation } from "../useWallboardPresentation";
import type { RuntimeDashboardState } from "../useRuntimeDashboard";
import type { GraphKind, GraphNode, RuntimeState } from "../types";
import { activityOptions } from "./ActivityChart";
import { WallboardDistributions, WallboardTrend } from "./WallboardAnalytics";
import { WallboardControls } from "./WallboardControls";
import "../styles/wallboard.css";

const Scene = lazy(() => import("./WallboardScene"));
const GraphView = lazy(() => import("./GraphView").then((module) => ({ default: module.GraphView })));
const roles = ["planner", "executor", "observer", "runtime"];
const statuses: Record<string, string> = { open: "待执行", completed: "已完成", blocked: "阻塞", failed: "失败", archived: "已归档", unknown: "未知" };
function count(metric: CountMetric) { return metric.value === null ? "--" : `${metric.state === "complete" ? "" : "已加载 "}${metric.value}`; }
function normalize(value: string) { return value.replace(/\/+$/, "") || ".agent-runtime"; }
function time(value?: string) { const date = new Date(value ?? ""); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour12: false }) : "--"; }
function useMedia(query: string) { const [matches, setMatches] = useState(() => matchMedia(query).matches); useEffect(() => { const media = matchMedia(query); const update = () => setMatches(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, [query]); return matches; }
function Clock() { const [now, setNow] = useState(new Date()); useEffect(() => { let timer: number; const start = () => { clearInterval(timer); if (!document.hidden) { setNow(new Date()); timer = window.setInterval(() => setNow(new Date()), 1000); } }; document.addEventListener("visibilitychange", start); start(); return () => { clearInterval(timer); document.removeEventListener("visibilitychange", start); }; }, []); const zone = new Intl.DateTimeFormat("zh-CN", { timeZoneName: "short" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value; return <time className="wall-clock">{now.toLocaleTimeString("zh-CN", { hour12: false })}<small title={Intl.DateTimeFormat().resolvedOptions().timeZone}>{now.toLocaleDateString("zh-CN")} · {zone}</small></time>; }

export default function WallboardView(p: { dashboard: RuntimeDashboardState; data?: RuntimeState; situation: Situation; navigation: NavigationState; onNavigate: (patch: Partial<NavigationState>, mode?: "push" | "replace") => void }) {
  return <FixedDarkTheme><Wallboard {...p} /></FixedDarkTheme>;
}
function Wallboard({ dashboard, data, situation, navigation, onNavigate }: { dashboard: RuntimeDashboardState; data?: RuntimeState; situation: Situation; navigation: NavigationState; onNavigate: (patch: Partial<NavigationState>, mode?: "push" | "replace") => void }) {
  const small = useMedia("(max-width: 1023px), (orientation: portrait)");
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const compact = useMedia("(max-width: 1599px), (max-height: 899px)");
  const [motion, setMotion] = useState(true), [tour, setTour] = useState(false), [threeChoice, setThreeChoice] = useState<boolean>();
  const [failure, setFailure] = useState(""), [alias, setAlias] = useState(""), [tourId, setTourId] = useState<string>();
  const kind = (navigation.wallGraph ?? "operation") as GraphKind;
  const distance = navigation.wallSize === "distance";
  const three = kind === "operation" && (threeChoice ?? !small) && !failure;
  const running = dashboard.runsKnown && dashboard.activeRuns.some((run) => normalize(run.runtimeDir) === normalize(data?.runtimeDir ?? navigation.runtimeDir) && run.running === true);
  const active = dashboard.autoRefresh && dashboard.visible && running && !dashboard.delayed && !dashboard.error && !reduced && motion && Boolean(data);
  const presentation = useWallboardPresentation(navigation.runtimeDir, data, active, navigation.nodeId);
  const selected = situation.nodes.find((node) => node.id === navigation.nodeId);
  const focus = selected ?? (navigation.nodeId ? undefined : situation.nodes.find((node) => node.id === tourId) ?? presentation.focus);
  const graph = useMemo(() => kind === "task" ? projectTaskTree(situation.nodes, situation.edges) : situation, [kind, situation]);
  const projected = useMemo(() => projectGraph(graph, { kind, selectedId: navigation.nodeId ?? tourId }), [graph, kind, navigation.nodeId, tourId]);
  const findings = situation.findings.all.filter((node) => node.type === "Vulnerability" || (node.type === "Exploit" && node.properties.status === "succeeded") || (node.type === "Hypothesis" && ["open", "inconclusive", undefined].includes(node.properties.status as string | undefined)));
  const tourCandidates = useRef<GraphNode[]>([]);
  const linkedFindings = new Set(findings.map((node) => node.id));
  const linked = new Set(situation.edges.flatMap((edge) => linkedFindings.has(edge.from) || linkedFindings.has(edge.to) ? [edge.from, edge.to] : []));
  tourCandidates.current = situation.nodes.filter((node) => linked.has(node.id) && node.graphKind === kind).slice(0, 5);
  const shownFindings = findings.slice(0, distance || compact ? 2 : 3);
  const exceptions = situation.tasks.all.filter((node) => ["blocked", "failed"].includes(String(node.properties.status)));
  const options = activityOptions(navigation, data?.loadedAt);
  const from = options.start ? Date.parse(options.start) : options.relativeMs && data ? Date.parse(data.loadedAt) - options.relativeMs : -Infinity;
  const to = options.end ? Date.parse(options.end) : Infinity;
  const recent = useMemo(() => (data?.traceItems ?? []).filter((item) => Date.parse(item.timestamp) >= from && Date.parse(item.timestamp) <= to).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)), [data, from, to]);
  useEffect(() => { setAlias(""); setTour(false); setTourId(undefined); setFailure(""); setThreeChoice(undefined); }, [navigation.runtimeDir]);
  useEffect(() => {
    if (!tour || !active) { setTourId(undefined); return; }
    let index = 0;
    const timer = window.setInterval(() => { const candidates = tourCandidates.current; if (candidates.length) setTourId(candidates[index++ % candidates.length].id); }, 15000);
    return () => clearInterval(timer);
  }, [tour, active, navigation.runtimeDir, kind]);
  const interact = () => { setTour(false); setTourId(undefined); };
  const select = (nodeId?: string) => { interact(); onNavigate({ nodeId }, "replace"); };
  const nodeLink = (node: GraphNode) => navigationUrl({ runtimeDir: navigation.runtimeDir, view: ["operation", "reasoning", "task"].includes(node.graphKind) ? node.graphKind as GraphKind : "overview", nodeId: node.id });
  const state = dashboard.error ? "数据请求失败" : dashboard.delayed ? "数据延迟" : !dashboard.autoRefresh ? "展示已暂停" : !dashboard.runsKnown ? "运行状态未知" : running ? "运行中" : "历史快照";
  const metrics = [{ label: "主机", value: situation.assets.hosts, icon: Server, tone: "ice" }, { label: "服务", value: situation.assets.services, icon: Layers, tone: "teal" }, { label: "Web 端点", value: situation.assets.webEndpoints, icon: Globe, tone: "amber" }, { label: "漏洞发现", value: situation.findings.vulnerabilities, icon: ShieldAlert, tone: "coral" }, { label: "成功利用", value: situation.findings.exploits, icon: ShieldCheck, tone: "green" }, { label: "证据产物", value: situation.counts.artifacts, icon: Database, tone: "ice" }];
  return <main className={`wallboard ${distance ? "wall-distance" : ""} ${active ? "wall-active" : ""}`} data-theme="dark">
    <picture className="wall-background">
      <source media="(min-width: 2560px)" type="image/webp" srcSet="/art/wallboard-surface-v3-4k.webp" />
      <source type="image/webp" srcSet="/art/wallboard-surface-v3-1080.webp" />
      <img src="/art/wallboard-surface-v3-1080.png" srcSet="/art/wallboard-surface-v3-1080.png 1920w, /art/wallboard-surface-v3-4k.png 3840w" sizes="100vw" alt="" />
    </picture>
    <header className="wall-header"><div className="wall-target"><span>当前目标</span><strong title={data?.overview.goal?.label}>{alias || data?.overview.goal?.label || (dashboard.loading ? "正在加载运行" : "暂无目标")}</strong></div><div className="wall-brand"><img src="/brand/qingxuan-symbol-on-dark-128.png" alt="" /><div><h1>青玄</h1><p>自动渗透agent<span>态势感知中心</span></p></div></div><div className="wall-live"><span className={`wall-state ${running ? "running" : ""}`} role="status">{state}</span><Clock /></div></header>
    <section className="wall-metrics" aria-label="当前快照统计">{metrics.map(({ label, value, icon: Icon, tone }) => <div className={`wall-metric ${tone}`} key={label}><span><Icon size={19} />{label}</span><strong>{value.value ?? "--"}</strong><small>{value.state === "complete" ? "当前快照" : value.state === "unavailable" ? "数据不可用" : value.state === "partial" ? "部分已加载" : "已加载 · 覆盖未知"}</small></div>)}</section>
    <div className="wall-primary"><aside className="wall-left wall-band"><WallboardDistributions situation={situation} /><section className="wall-roles"><header><h2>角色活动</h2><span>最近记录</span></header>{roles.map((role) => { const latest = (data?.traceItems ?? []).filter((item) => item.role === role).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]; return <div className={`wall-role ${role}`} key={role}><div><strong>{role}</strong><time>{time(latest?.timestamp)}</time></div><p title={latest?.title}>{latest?.title || "暂无活动记录"}</p></div>; })}</section></aside>
      <section className="wall-stage"><header><h2>{kind === "operation" ? "资产拓扑" : kind === "reasoning" ? "证据关系" : "任务树"}</h2><span>{three ? "3D" : "2D"} · 当前快照</span></header><div className="wall-stage-graph"><Suspense fallback={<p className="wall-empty">正在加载图谱</p>}>{three ? <Scene runtimeDir={navigation.runtimeDir} nodes={projected.nodes} edges={projected.edges} selectedId={navigation.nodeId ?? tourId} pulseIds={presentation.pulseIds} edgeRefs={presentation.edgeRefs} active={active} onSelect={select} onFailure={setFailure} onInteraction={interact} /> : <GraphView compact presentation runtimeDir={navigation.runtimeDir} kind={kind} nodes={graph.nodes} edges={graph.edges} selectedNodeId={navigation.nodeId ?? tourId} linkedNodeIds={[]} onSelectNode={select} />}</Suspense></div><div className="wall-stage-caption"><span>{projected.nodes.length} 节点 · {projected.edges.length} 关系{projected.omittedNodes || projected.omittedEdges ? ` · 未展示 ${projected.omittedNodes} 节点 / ${projected.omittedEdges} 关系` : ""}{projected.unloadedEdges ? ` · ${projected.unloadedEdges} 关系端点未加载` : ""}</span><Select showSearch optionFilterProp="label" aria-label="选择真实节点" placeholder="节点索引" value={projected.nodes.some((node) => node.id === navigation.nodeId) ? navigation.nodeId : undefined} allowClear onChange={select} options={projected.nodes.map((node) => ({ value: node.id, label: node.label || node.id }))} /></div>{failure ? <div className="wall-fallback" role="status">{failure}<Button onClick={() => { setFailure(""); setThreeChoice(true); }}>重试三维</Button></div> : null}</section>
      <aside className="wall-right wall-band"><section className="wall-findings"><header><h2>最新发现</h2><span>{findings.length}</span></header>{shownFindings.map((node) => <button key={node.id} className={`wall-finding ${node.id === focus?.id ? "selected" : ""}`} onClick={() => select(node.id)}><span>{node.type === "Vulnerability" ? "漏洞" : node.type === "Exploit" ? "利用" : "待验证假设"}<small>{hasFindingEvidence(node) ? `${node.evidenceRefs.length} 条证据` : "待补证据"}</small></span><strong title={node.label}>{node.label}</strong><em>{String(node.properties.status || "状态未知")}</em></button>)}{!findings.length ? <p className="wall-empty">暂无已加载发现</p> : null}{findings.length > shownFindings.length ? <small>其余 {findings.length - shownFindings.length} 项发现</small> : null}</section><section className="wall-exceptions"><header><h2>阻塞与失败</h2><span>{count(situation.tasks.byStatus.blocked)} / {count(situation.tasks.byStatus.failed)}</span></header>{exceptions.slice(0, distance || compact ? 1 : 2).map((node) => <button key={node.id} onClick={() => select(node.id)}><span>{statuses[String(node.properties.status)]}</span><strong title={node.label}>{node.label}</strong></button>)}{!exceptions.length ? <p className="wall-empty">暂无已加载阻塞或失败任务</p> : null}</section></aside></div>
    <div className="wall-bottom"><WallboardTrend data={data} navigation={navigation} /><section className="wall-focus"><header><h2>当前焦点</h2>{navigation.nodeId ? <Tooltip title="清除选择"><Button aria-label="清除选择" size="small" icon={<X size={16} />} onClick={() => select(undefined)} /></Tooltip> : null}</header>{navigation.nodeId && !selected ? <p>所选节点未加载或已不存在</p> : focus ? <><strong title={focus.label}>{focus.label}</strong><p>{focus.type} · {String(focus.properties.status || (focus.graphKind === "operation" ? ({ candidate: "候选资产", verified: "已验证", unknown: "验证状态未知" }[assetValidation(focus)]) : "状态未知"))} · {focus.evidenceRefs.length} 条证据</p><a href={nodeLink(focus)}>在工作台查看 <ArrowUpRight size={16} /></a></> : <><strong>{data?.overview.tasks.latest?.label || "暂无当前焦点"}</strong><p>候选资产 {count(situation.assets.candidates)} · 验证未知 {count(situation.assets.unknown)}</p><small>待补证据 {count(situation.findings.missingEvidence)}</small></>}</section><section className="wall-events"><header><h2>最近事件</h2><span>{navigation.range === "loaded" || !navigation.range ? "已加载" : navigation.range}</span></header>{recent.slice(0, distance ? 2 : 3).map((item) => <a href={navigationUrl({ runtimeDir: navigation.runtimeDir, view: "trace", traceId: item.id, range: "loaded" })} key={item.id}><time>{time(item.timestamp)}</time><span title={item.title}>{item.title}</span></a>)}{!recent.length ? <p className="wall-empty">暂无已加载事件</p> : null}</section></div>
    <footer className="wall-footer"><span title={dashboard.error}>{dashboard.error ? "数据请求失败 · 保留最近成功快照" : `快照 ${time(data?.loadedAt)} · ${situation.counts.nodes.state === "complete" ? "图谱节点完整" : "图谱节点仅已加载"}`}</span><span>{!dashboard.autoRefresh ? "展示已暂停 · Agent 不受影响" : reduced ? "减少动态效果" : running ? "自动刷新" : "静态展示"}</span></footer>
    <WallboardControls dashboard={dashboard} navigation={navigation} onNavigate={(patch, mode) => { interact(); onNavigate(patch, mode); }} motion={motion} onMotion={setMotion} tour={tour} onTour={setTour} three={three} onThree={(value) => { setThreeChoice(value); if (value) setFailure(""); }} alias={alias} onAlias={setAlias} goal={data?.overview.goal?.label ?? ""} />
  </main>;
}
