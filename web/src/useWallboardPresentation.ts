import { useEffect, useRef, useState } from "react";
import { hasFindingEvidence } from "./situation";
import type { GraphNode, RuntimeState } from "./types";

export function useWallboardPresentation(runtimeDir: string, data: RuntimeState | undefined, active: boolean, selectedId?: string) {
  const baseline = useRef<{ runtime: string; active: boolean; nodes: Map<string, string>; events: Set<string> } | undefined>(undefined);
  const awaitingSnapshot = useRef<RuntimeState | undefined>(undefined);
  const [pulseIds, setPulseIds] = useState<string[]>([]);
  const [edgeRefs, setEdgeRefs] = useState<string[][]>([]);
  const [focus, setFocus] = useState<GraphNode>();
  const timers = useRef<{ pulse?: number; edges?: number; focus?: number }>({});
  useEffect(() => {
    const previous = baseline.current;
    const nodes = new Map((data?.graph.nodes ?? []).filter((node) => node.id).map((node) => [node.id, String(node.properties.status ?? "")]));
    const traces = (data?.traceItems ?? []).filter((item) => item.eventId);
    const events = new Set([...(previous?.runtime === runtimeDir ? previous.events : []), ...traces.map((item) => item.eventId)].slice(-1000));
    const reset = !previous || previous.runtime !== runtimeDir || !previous.active || !active;
    baseline.current = { runtime: runtimeDir, active: active && Boolean(data), nodes, events };
    if (reset) { awaitingSnapshot.current = active ? data : undefined; Object.values(timers.current).forEach(clearTimeout); timers.current = {}; setPulseIds([]); setEdgeRefs([]); setFocus(undefined); return; }
    if (awaitingSnapshot.current) { if (data !== awaitingSnapshot.current) awaitingSnapshot.current = undefined; return; }
    const changed = (data?.graph.nodes ?? []).filter((node) => node.id && (!previous.nodes.has(node.id) || previous.nodes.get(node.id) !== String(node.properties.status ?? ""))).sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
    if (changed.length) {
      setPulseIds(changed.slice(0, 5).map((node) => node.id));
      clearTimeout(timers.current.pulse); timers.current.pulse = window.setTimeout(() => setPulseIds([]), 800);
      const finding = changed.find((node) => hasFindingEvidence(node) && (node.type === "Vulnerability" || (node.type === "Exploit" && node.properties.status === "succeeded")));
      if (finding && !selectedId) { setFocus(finding); clearTimeout(timers.current.focus); timers.current.focus = window.setTimeout(() => setFocus(undefined), 6000); }
    }
    const refs = traces.filter((item) => !previous.events.has(item.eventId) && item.graphNodeRefs.length >= 2).slice(-3).map((item) => item.graphNodeRefs);
    if (refs.length) { setEdgeRefs(refs); clearTimeout(timers.current.edges); timers.current.edges = window.setTimeout(() => setEdgeRefs([]), 1000); }
  }, [runtimeDir, data, active]);
  useEffect(() => { if (selectedId) setFocus(undefined); }, [selectedId]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  return { pulseIds, edgeRefs, focus };
}
