import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Drawer, Tabs, Tooltip } from "antd";
import { Activity, FileText, LayoutDashboard, Menu, Monitor, Network, Settings, ShieldAlert, Workflow, X } from "lucide-react";
import { useLanguage } from "../language";
import type { ViewKey } from "../types";
import { Brand } from "./Brand";
const groups = [
  { label: "总览", en: "Overview", icon: LayoutDashboard, views: ["overview"] },
  { label: "资产", en: "Assets", icon: Network, views: ["operation"] },
  { label: "执行", en: "Execution", icon: Activity, views: ["trace", "task"] },
  { label: "发现", en: "Findings", icon: ShieldAlert, views: ["findings", "reasoning"] },
  { label: "网络", en: "Network", icon: Workflow, views: ["traffic", "connections"] },
  { label: "产出", en: "Reports", icon: FileText, views: ["reports"] },
  { label: "管理", en: "Manage", icon: Settings, views: ["skills", "mcp", "approvals"] }
];
const titles: Partial<Record<ViewKey, [string, string]>> = { overview: ["态势总览", "Overview"], operation: ["资产拓扑", "Asset topology"], trace: ["执行轨迹", "Trace"], task: ["任务树", "Tasks"], findings: ["发现列表", "Findings"], reasoning: ["证据关系", "Evidence graph"], traffic: ["请求记录", "Traffic"], connections: ["连接管理", "Connections"], reports: ["产物与报告", "Artifacts & reports"], skills: ["Skills", "Skills"], mcp: ["MCP", "MCP"], approvals: ["审批", "Approvals"] };
export function WorkbenchShell({ view, wallboardUrl, onViewChange, onHome, canApprove, pendingCount, toolbar, children, inspector, onCloseInspector }: { view: ViewKey; wallboardUrl?: string; onViewChange: (view: ViewKey) => void; onHome?: () => void; canApprove: boolean; pendingCount: number; toolbar: ReactNode; children: ReactNode; inspector?: ReactNode; onCloseInspector: () => void }) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [mobile, setMobile] = useState(false);
  const [wide, setWide] = useState(() => window.innerWidth >= 1440);
  const inspectorRef = useRef<HTMLElement>(null);
  const hasInspector = Boolean(inspector);
  useEffect(() => {
    if (!hasInspector || wide) return;
    const previous = document.activeElement as HTMLElement | null;
    inspectorRef.current?.focus();
    return () => previous?.focus();
  }, [hasInspector, wide]);
  useEffect(() => { const resize = () => setWide(window.innerWidth >= 1440); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const select = (next: ViewKey) => { if (next === "wallboard" && wallboardUrl) { const tab = window.open("about:blank", "_blank"); if (tab) { tab.opener = null; tab.location.href = wallboardUrl; setMobile(false); return; } } onViewChange(next); setMobile(false); };
  const navigation = <nav className="qx-rail" aria-label="Workbench">{onHome ? <Tooltip title={zh ? "返回首页" : "Back to home"} placement="right"><button type="button" className="qx-rail-home" aria-label={zh ? "返回首页" : "Back to home"} onClick={() => { setMobile(false); onHome(); }}><Brand /></button></Tooltip> : <Brand />}{groups.map((group) => <Tooltip title={zh ? group.label : group.en} placement="right" key={group.label}><button type="button" className={group.views.includes(view) ? "active" : ""} aria-current={group.views.includes(view) ? "page" : undefined} onClick={() => select(group.views[0] as ViewKey)}><Badge count={group.label === "管理" && canApprove ? pendingCount : 0} size="small"><group.icon size={20} /></Badge><span>{zh ? group.label : group.en}</span></button></Tooltip>)}<span className="qx-rail-spacer" /><Tooltip title={zh ? "态势大屏" : "Wallboard"} placement="right"><button type="button" onClick={() => select("wallboard")}><Monitor size={20} /><span>{zh ? "大屏" : "Display"}</span></button></Tooltip></nav>;
  const group = groups.find((item) => item.views.includes(view));
  const tabs = (group?.views ?? []).filter((key) => key !== "approvals" || canApprove);
  return <div className={"qx-workbench " + (inspector && wide ? "with-inspector" : "")}>
    <div className="qx-desktop-rail" inert={hasInspector && !wide}>{navigation}</div>
    <div className="qx-workspace" inert={hasInspector && !wide}>
      <header className="qx-topbar"><Button className="qx-menu-trigger" aria-label={zh ? "打开导航" : "Open navigation"} icon={<Menu size={18} />} onClick={() => setMobile(true)} /><strong className="qx-page-title">{titles[view]?.[zh ? 0 : 1] ?? "青玄"}</strong>{toolbar}</header>
      {tabs.length > 1 ? <Tabs className="qx-group-tabs" activeKey={view} onChange={(key) => select(key as ViewKey)} items={tabs.map((key) => ({ key, label: titles[key as ViewKey]?.[zh ? 0 : 1] ?? key }))} /> : null}
      <main className="qx-main">{children}</main>
    </div>
    {inspector ? <><button className="qx-inspector-mask" aria-hidden="true" tabIndex={-1} onClick={onCloseInspector} /><aside ref={inspectorRef} className="qx-inspector" role={wide ? "complementary" : "dialog"} aria-label={zh ? "详情" : "Details"} aria-modal={wide ? undefined : true} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onCloseInspector(); }
      if (!wide && event.key === "Tab") {
        const controls = Array.from(inspectorRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []).filter((element) => element.offsetParent !== null);
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === inspectorRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}><Button className="qx-inspector-close" icon={<X size={16} />} aria-label={zh ? "关闭详情" : "Close details"} onClick={onCloseInspector} />{inspector}</aside></> : null}
    <Drawer open={mobile} placement="left" size={200} onClose={() => setMobile(false)} styles={{ body: { padding: 0 } }}>{mobile ? navigation : null}</Drawer>
  </div>;
}
