import { useEffect, useRef, useState } from "react";
import { Button, Input, Popover, Segmented, Select, Switch, Tooltip } from "antd";
import { ArrowLeft, Expand, Minimize, Pause, Play, RefreshCw, Settings } from "lucide-react";
import type { NavigationState } from "../navigation";
import type { RuntimeDashboardState } from "../useRuntimeDashboard";

export interface WallboardControlsProps {
  dashboard: RuntimeDashboardState; navigation: NavigationState;
  onNavigate: (patch: Partial<NavigationState>, mode?: "push" | "replace") => void;
  motion: boolean; onMotion: (value: boolean) => void; tour: boolean; onTour: (value: boolean) => void;
  three: boolean; onThree: (value: boolean) => void; alias: string; onAlias: (value: string) => void; goal: string;
}
export function WallboardControls(p: WallboardControlsProps) {
  const [open, setOpen] = useState(false);
  const [awake, setAwake] = useState(true);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let timer: number;
    const wake = () => { setAwake(true); clearTimeout(timer); if (!document.hidden) timer = window.setTimeout(() => { if (!ref.current?.contains(document.activeElement)) setAwake(false); }, 8000); };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) wake(); };
    const change = () => setFullscreen(Boolean(document.fullscreenElement));
    window.addEventListener("pointermove", wake); window.addEventListener("keydown", wake); document.addEventListener("fullscreenchange", change); document.addEventListener("visibilitychange", visibility); wake();
    return () => { clearTimeout(timer); window.removeEventListener("pointermove", wake); window.removeEventListener("keydown", wake); document.removeEventListener("fullscreenchange", change); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const toggleFullscreen = async () => { try { setError(""); if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector<HTMLElement>(".wallboard")?.requestFullscreen(); } catch { setError("无法进入全屏，请检查浏览器权限"); } };
  const settings = <div className="wall-settings"><label>动态展示 <Switch checked={p.motion} onChange={p.onMotion} /></label><label>发现轮巡 <Switch checked={p.tour} onChange={p.onTour} /></label><label>资产三维 <Switch disabled={(p.navigation.wallGraph ?? "operation") !== "operation"} checked={p.three} onChange={p.onThree} /></label><label>显示别名<Input value={p.alias} maxLength={80} onChange={(e) => p.onAlias(e.target.value)} /></label><details><summary>完整目标</summary><p>{p.goal || "目标未加载"}</p></details><Button onClick={() => p.onNavigate({ view: "overview" })} icon={<ArrowLeft size={16} />}>返回工作台</Button></div>;
  return <div ref={ref} className={`wall-controls ${awake || open ? "awake" : "asleep"}`} onFocus={() => setAwake(true)}>
    <div className="wall-controls-aux"><Tooltip title="返回同一运行的工作台"><Button aria-label="返回工作台" icon={<ArrowLeft size={18} />} onClick={() => p.onNavigate({ view: "overview", nodeId: undefined })} /></Tooltip>
      <Select aria-label="运行" className="wall-runtime-select" value={p.navigation.runtimeDir} options={[{ value: p.navigation.runtimeDir, label: p.dashboard.sessions.find((s) => s.runtimeDir === p.navigation.runtimeDir)?.name || p.navigation.runtimeDir }, ...p.dashboard.sessions.filter((s) => s.runtimeDir !== p.navigation.runtimeDir).map((s) => ({ value: s.runtimeDir, label: s.name || s.runtimeDir }))]} onChange={(runtimeDir) => p.onNavigate({ runtimeDir })} />
      <Segmented aria-label="图谱模式" value={p.navigation.wallGraph ?? "operation"} onChange={(wallGraph) => p.onNavigate({ wallGraph, nodeId: undefined }, "replace")} options={[{ value: "operation", label: "资产" }, { value: "reasoning", label: "证据" }, { value: "task", label: "任务" }]} />
      <Select aria-label="事件时间范围" value={p.navigation.range ?? "loaded"} onChange={(range) => p.onNavigate({ range }, "replace")} options={[{ value: "loaded", label: "全部已加载" }, { value: "15m", label: "15 分钟" }, { value: "1h", label: "1 小时" }, { value: "24h", label: "24 小时" }, { value: "custom", label: "自定义时间" }]} />
      {p.navigation.range === "custom" ? <><Input type="datetime-local" aria-label="开始 UTC" value={p.navigation.from?.slice(0, 16) ?? ""} onChange={(e) => p.onNavigate({ from: e.target.value ? e.target.value + ":00Z" : undefined }, "replace")} /><Input type="datetime-local" aria-label="结束 UTC" value={p.navigation.to?.slice(0, 16) ?? ""} onChange={(e) => p.onNavigate({ to: e.target.value ? e.target.value + ":00Z" : undefined }, "replace")} /></> : null}
      <Segmented aria-label="展示字号" value={p.navigation.wallSize ?? "standard"} onChange={(wallSize) => p.onNavigate({ wallSize }, "replace")} options={[{ value: "standard", label: "标准" }, { value: "distance", label: "远距" }]} />
      <Tooltip title="仅暂停大屏刷新，不会停止 Agent"><Button aria-label={p.dashboard.autoRefresh ? "暂停大屏" : "恢复大屏"} icon={p.dashboard.autoRefresh ? <Pause size={18} /> : <Play size={18} />} onClick={() => p.dashboard.setAutoRefresh(!p.dashboard.autoRefresh)} /></Tooltip>
      <Tooltip title="刷新一次"><Button aria-label="刷新一次" loading={p.dashboard.refreshing} icon={<RefreshCw size={18} />} onClick={() => void p.dashboard.refresh()} /></Tooltip>
      <Tooltip title={fullscreen ? "退出全屏" : "全屏"}><Button aria-label="切换全屏" icon={fullscreen ? <Minimize size={18} /> : <Expand size={18} />} onClick={() => void toggleFullscreen()} /></Tooltip>
    </div><Popover content={settings} trigger="click" open={open} onOpenChange={setOpen} placement="topRight"><Button className="wall-settings-trigger" aria-label="大屏设置" icon={<Settings size={19} />} /></Popover>{error ? <span role="alert" className="wall-control-error">{error}</span> : null}
  </div>;
}
