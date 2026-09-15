import { useEffect, useRef } from "react";
import { Button, Tooltip } from "antd";
import { Focus, Minus, Plus } from "lucide-react";
import { createWallboardScene } from "./wallboardScene";
import type { GraphEdge, GraphNode } from "../types";

export default function WallboardScene(p: { runtimeDir: string; nodes: GraphNode[]; edges: GraphEdge[]; selectedId?: string; pulseIds: string[]; edgeRefs: string[][]; active: boolean; onSelect: (id: string) => void; onFailure: (reason: string) => void; onInteraction: () => void }) {
  const container = useRef<HTMLDivElement>(null), labels = useRef<HTMLDivElement>(null);
  const engine = useRef<ReturnType<typeof createWallboardScene> | undefined>(undefined);
  const latest = useRef(p); latest.current = p;
  useEffect(() => {
    try { engine.current = createWallboardScene(container.current!, labels.current!, p.runtimeDir, (id) => latest.current.onSelect(id), (reason) => latest.current.onFailure(reason), () => latest.current.onInteraction()); }
    catch { latest.current.onFailure("此设备无法初始化三维，已切换二维"); }
    return () => { engine.current?.dispose(); engine.current = undefined; };
  }, [p.runtimeDir]);
  useEffect(() => { void engine.current?.update(p.nodes, p.edges).catch(() => latest.current.onFailure("三维布局不可用，已切换二维")); }, [p.nodes, p.edges, p.runtimeDir]);
  useEffect(() => { engine.current?.presentation(p.selectedId, p.pulseIds, p.edgeRefs, p.active); }, [p.selectedId, p.pulseIds, p.edgeRefs, p.active]);
  const labeled = [...p.nodes].sort((a, b) => Number(b.id === p.selectedId) - Number(a.id === p.selectedId) || Number(b.type === "Host") - Number(a.type === "Host")).slice(0, 10);
  return <div ref={container} className="wall-three"><div ref={labels} className="wall-scene-labels">{labeled.map((node) => <button key={node.id} data-node={node.id} title={node.label} className={node.id === p.selectedId ? "selected" : ""} onClick={() => p.onSelect(node.id)}>{node.label || node.id}</button>)}</div><div className="wall-scene-tools"><Tooltip title="缩小"><Button aria-label="缩小拓扑" icon={<Minus size={18} />} onClick={() => { p.onInteraction(); engine.current?.zoom(1 / 1.2); }} /></Tooltip><Tooltip title="放大"><Button aria-label="放大拓扑" icon={<Plus size={18} />} onClick={() => { p.onInteraction(); engine.current?.zoom(1.2); }} /></Tooltip><Tooltip title="重置视角"><Button aria-label="重置视角" icon={<Focus size={18} />} onClick={() => { p.onInteraction(); engine.current?.fit(); }} /></Tooltip></div>{!p.nodes.length ? <p className="wall-scene-empty">尚无已加载资产</p> : null}</div>;
}
