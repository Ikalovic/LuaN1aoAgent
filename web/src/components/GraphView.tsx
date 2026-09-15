import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Segmented, Select, Tag, Tooltip } from "antd";
import cytoscape, { type Core, type EdgeSingular, type ElementDefinition, type StylesheetJson } from "cytoscape";
import { Focus, List, ListFilter, Minus, Plus, RefreshCw, Search, X } from "lucide-react";
import { edgePresentation, filterGraph, nodeDisplayLabel, nodePalette, taskProgressSummary } from "../graph";
import { layoutGraph, layoutStructureKey } from "../graphLayout";
import { projectGraph } from "../situation";
import { useTheme } from "../ThemeProvider";
import { themeColors, type ThemeMode } from "../theme";
import { useLanguage } from "../language";
import type { GraphEdge, GraphKind, GraphNode } from "../types";
import { shortRef } from "../utils";

interface GraphViewProps {
  runtimeDir: string;
  kind: GraphKind;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string;
  linkedNodeIds: string[];
  onSelectNode: (nodeId?: string) => void;
  nodeType?: string;
  compact?: boolean;
  presentation?: boolean;
  onClearFilters?: () => void;
}

export function GraphView(props: GraphViewProps) {
  const { t } = useLanguage();
  const { mode } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | undefined>(undefined);
  const onSelectNodeRef = useRef(props.onSelectNode);
  const [query, setQuery] = useState("");
  const [nodeTypes, setNodeTypes] = useState<string[]>([]);
  const [edgeTypes, setEdgeTypes] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [showIndex, setShowIndex] = useState(false);
  const [display, setDisplay] = useState("topology");
  const [allLoaded, setAllLoaded] = useState(false);
  const [layoutError, setLayoutError] = useState<string>();
  const lastStructure = useRef("");
  const fitted = useRef(false);

  useEffect(() => { onSelectNodeRef.current = props.onSelectNode; }, [props.onSelectNode]);

  useEffect(() => {
    setQuery("");
    setNodeTypes(props.nodeType ? [props.nodeType] : []);
    setEdgeTypes([]);
    setAllLoaded(false);
  }, [props.kind, props.runtimeDir, props.nodeType]);

  const allKindNodes = useMemo(
    () => props.nodes.filter((node) => node.graphKind === props.kind),
    [props.kind, props.nodes]
  );
  const filteredGraph = useMemo(
    () => filterGraph(props.nodes, props.edges, props.kind, query, nodeTypes, edgeTypes),
    [edgeTypes, nodeTypes, props.edges, props.kind, props.nodes, query]
  );
  const projection = useMemo(() => projectGraph(props.compact ? { nodes: props.nodes, edges: props.edges } : filteredGraph, { kind: props.kind, selectedId: props.selectedNodeId }), [filteredGraph, props.kind, props.selectedNodeId, props.compact, props.nodes, props.edges]);
  const unloadedEdges = useMemo(() => { const ids = new Set(props.nodes.map((node) => node.id)); return props.edges.filter((edge) => !ids.has(edge.from) || !ids.has(edge.to)).length; }, [props.nodes, props.edges]);
  const visibleGraph = !props.compact && (allLoaded || filteredGraph.nodes.length <= 200) ? filteredGraph : projection;
  const signature = useMemo(
    () => `${props.runtimeDir}|${layoutStructureKey(visibleGraph.nodes, visibleGraph.edges, props.kind)}|${layoutNonce}`,
    [layoutNonce, props.kind, props.runtimeDir, visibleGraph]
  );
  const nodeTypeOptions = useMemo(
    () => [...new Set(allKindNodes
      .filter((node) => props.kind !== "task" || ["Scope", "Goal", "Task"].includes(node.type))
      .map((node) => node.type))].sort().map((value) => ({ value, label: value })),
    [allKindNodes, props.kind]
  );
  const visibleIds = useMemo(() => new Set(visibleGraph.nodes.map((node) => node.id)), [visibleGraph.nodes]);
  const edgeTypeOptions = useMemo(
    () => [...new Set(props.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)).map((edge) => edge.type))]
      .sort().map((value) => ({ value, label: value })),
    [props.edges, visibleIds]
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const cy = cytoscape({ container: containerRef.current, elements: [], style: graphStyles(0, props.kind, mode, props.presentation), minZoom: 0.08, maxZoom: 3.2, boxSelectionEnabled: false, selectionType: "single" });
    cyRef.current = cy;
    fitted.current = false;
    lastStructure.current = "";
    cy.on("tap", "node", (event) => onSelectNodeRef.current(event.target.id()));
    cy.on("tap", (event) => { if (event.target === cy) onSelectNodeRef.current(undefined); });
    cy.on("zoom", () => { setZoom(cy.zoom()); updateLabelVisibility(cy, cy.nodes().length, cy.zoom(), props.presentation); });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (!cy.destroyed()) cy.resize(); }) : undefined;
    observer?.observe(containerRef.current);
    return () => { observer?.disconnect(); cy.destroy(); if (cyRef.current === cy) cyRef.current = undefined; };
  }, [props.runtimeDir, props.kind]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed()) return;
    const elements: ElementDefinition[] = [
      ...visibleGraph.nodes.map((node) => {
        const palette = nodePalette(node.type, mode);
        return {
          group: "nodes" as const,
          data: {
            id: node.id,
            label: nodeDisplayLabel(node, props.kind),
            fullLabel: node.label,
            type: node.type,
            color: palette.color,
            background: palette.background
          },
          classes: ""
        };
      }),
      ...visibleGraph.edges.map((edge, index) => {
        const presentation = edgePresentation(edge);
        return {
          group: "edges" as const,
          data: {
            id: edge.id || `edge:${edge.from}:${edge.type}:${edge.to}:${index}`,
            source: edge.from,
            target: edge.to,
            label: edge.type,
            type: edge.type,
            statusColor: presentation.color,
            lineStyle: presentation.lineStyle,
            statusOpacity: presentation.opacity
          }
        };
      })
    ];

    const ids = new Set(elements.map((element) => element.data.id));
    cy.batch(() => {
      cy.elements().filter((element) => !ids.has(element.id())).remove();
      for (const element of elements) {
        const current = cy.getElementById(element.data.id!);
        if (current.length) current.data(element.data); else cy.add(element);
      }
      cy.style(graphStyles(visibleGraph.nodes.length, props.kind, mode, props.presentation));
      updateLabelVisibility(cy, visibleGraph.nodes.length, cy.zoom(), props.presentation);
    });
  }, [visibleGraph, props.kind, mode, props.presentation]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.destroyed() || !visibleGraph.nodes.length || lastStructure.current === signature) return;
    const controller = new AbortController();
    const existing = new Set(cy.nodes().filter((node) => node.hasClass("positioned")).map((node) => node.id()));
    const explicit = lastStructure.current.split("|").at(-1) !== String(layoutNonce);
    void layoutGraph(visibleGraph.nodes, visibleGraph.edges, props.kind, controller.signal, props.runtimeDir).then((positions) => {
      if (!positions || controller.signal.aborted || cy.destroyed() || cyRef.current !== cy) return;
      cy.batch(() => cy.nodes().forEach((node) => { if (positions[node.id()] && (!existing.has(node.id()) || explicit)) node.position(positions[node.id()]); node.addClass("positioned"); }));
      if (!fitted.current || explicit) { cy.resize(); cy.fit(undefined, props.presentation ? 60 : 42); const limit = props.presentation ? 2.2 : 1.3; if (cy.zoom() > limit) { cy.zoom(limit); cy.center(); } fitted.current = true; }
      lastStructure.current = signature;
      setLayoutError(undefined);
    }).catch((error) => { if (!controller.signal.aborted && !cy.destroyed()) setLayoutError(String(error)); });
    return () => controller.abort();
  }, [signature]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("trace-linked");
    props.linkedNodeIds.forEach((nodeId) => cy.getElementById(nodeId).addClass("trace-linked"));
  }, [props.linkedNodeIds, signature]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("is-selected is-neighbor is-dimmed is-active-edge");
    if (!props.selectedNodeId) return;
    const selected = cy.getElementById(props.selectedNodeId);
    if (!selected.length) return;
    const neighborhood = selected.closedNeighborhood();
    cy.elements().difference(neighborhood).addClass("is-dimmed");
    selected.addClass("is-selected");
    selected.neighborhood("node").addClass("is-neighbor");
    selected.connectedEdges().addClass("is-active-edge");
    updateLabelVisibility(cy, cy.nodes().length, cy.zoom(), props.presentation);
  }, [props.selectedNodeId, signature]);

  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: Math.max(0.08, Math.min(3.2, cy.zoom() * factor)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };

  const fit = () => cyRef.current?.fit(undefined, 42);
  const relayout = () => {
    setLayoutNonce((value) => value + 1);
  };

  return (
    <div className="graph-workspace">
      <div className="graph-toolbar">
        {!props.compact ? <Segmented value={display} onChange={setDisplay} options={[{ value: "topology", label: "拓扑" }, { value: "list", label: "列表" }]} /> : null}
        <Input
          allowClear
          prefix={<Search size={15} />}
          placeholder={t("graph.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          placeholder={t("graph.nodeType")}
          suffixIcon={<ListFilter size={15} />}
          value={nodeTypes}
          options={nodeTypeOptions}
          onChange={setNodeTypes}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          allowClear
          placeholder={t("graph.edgeType")}
          value={edgeTypes}
          options={edgeTypeOptions}
          onChange={setEdgeTypes}
        />
        <div className="graph-toolbar-actions">
          <Tooltip title={t("graph.nodeList")}><Button icon={<List size={16} />} aria-label={t("graph.nodeList")} onClick={() => setShowIndex((value) => !value)} /></Tooltip>
          <Tooltip title={t("graph.zoomOut")}><Button icon={<Minus size={16} />} onClick={() => zoomBy(1 / 1.18)} aria-label={t("graph.zoomOut")} /></Tooltip>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <Tooltip title={t("graph.zoomIn")}><Button icon={<Plus size={16} />} onClick={() => zoomBy(1.18)} aria-label={t("graph.zoomIn")} /></Tooltip>
          <Tooltip title={t("graph.fit")}><Button icon={<Focus size={16} />} onClick={fit} aria-label={t("graph.fit")} /></Tooltip>
          <Tooltip title={t("graph.relayout")}><Button icon={<RefreshCw size={16} />} onClick={relayout} aria-label={t("graph.relayout")} /></Tooltip>
          <Tooltip title={t("graph.clearSelection")}><Button icon={<X size={16} />} onClick={() => props.onSelectNode(undefined)} aria-label={t("graph.clearSelection")} /></Tooltip>
        </div>
      </div>

      {layoutError ? <Alert type="error" message={layoutError} /> : null}
      {!props.compact && props.selectedNodeId && !visibleGraph.nodes.some((node) => node.id === props.selectedNodeId) ? <Alert type="info" title="所选节点不在当前图中" action={<Button size="small" onClick={() => { setQuery(""); setNodeTypes([]); setEdgeTypes([]); setAllLoaded(true); props.onClearFilters?.(); }}>清除筛选并定位</Button>} /> : null}
      {!props.compact && filteredGraph.nodes.length > 200 ? <Button type="link" onClick={() => setAllLoaded((value) => !value)}>{allLoaded ? "局部投影" : `全部已加载 ${filteredGraph.nodes.length}`}</Button> : null}
      <div className={`graph-body ${display === "list" ? "graph-list-mode" : ""}`}>
        {showIndex || display === "list" ? <aside className="graph-node-index" aria-label={t("graph.nodeList")}>
          <div className="graph-index-head">
            <strong>{t("graph.nodes")}</strong>
            <span>{visibleGraph.nodes.length}</span>
          </div>
          <div className="graph-index-list">
            {visibleGraph.nodes.length ? visibleGraph.nodes.map((node) => {
              const palette = nodePalette(node.type, mode);
              const progress = props.kind === "task" ? taskProgressSummary(node) : undefined;
              return (
                <button
                  className={node.id === props.selectedNodeId ? "active" : ""}
                  key={node.id}
                  type="button"
                  onClick={() => props.onSelectNode(node.id)}
                >
                  <i style={{ background: palette.color }} />
                  <span>
                    <strong>{node.label}</strong>
                    <small>{node.type} · {shortRef(node.id, 28)}</small>
                    {progress ? <em>{progress}</em> : null}
                  </span>
                </button>
              );
            }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("graph.noMatchingNodes")} />}
          </div>
        </aside> : null}
        <div className="graph-canvas-wrap">
          <div ref={containerRef} className="graph-canvas" />
          {!visibleGraph.nodes.length ? <div className="graph-empty"><Empty description={t("graph.noVisibleNodes")} /></div> : null}
          <div className="graph-legend">
            {[...new Set(visibleGraph.nodes.map((node) => node.type))].slice(0, 8).map((type) => {
              const palette = nodePalette(type, mode);
              return <Tag key={type} style={{ color: palette.color, background: palette.background, borderColor: palette.color }}>{type}</Tag>;
            })}
          </div>
          <div className="graph-counts">{t("graph.counts", { nodes: visibleGraph.nodes.length, edges: visibleGraph.edges.length, relations: t(props.kind === "task" ? "graph.treeRelations" : "graph.relations") })}{visibleGraph === projection && projection.omittedNodes ? ` · 未显示 ${projection.omittedNodes} 节点 / ${projection.omittedEdges} 关系` : ""}{unloadedEdges ? ` · 端点未加载 ${unloadedEdges}` : ""}</div>
        </div>
      </div>
    </div>
  );
}

function updateLabelVisibility(cy: Core, nodeCount: number, zoom: number, presentation = false) {
  if (presentation) {
    cy.nodes().style({ label: zoom < .3 ? "" : "data(label)", "font-size": Math.min(28, Math.max(16, 14 / zoom)) });
    cy.nodes(".is-selected").style("label", "data(label)");
    return;
  }
  cy.nodes().not(".is-selected").style("label", zoom < 0.58 ? "" : "data(label)");
  cy.nodes(".is-selected").style("label", "data(label)");
}

function graphStyles(nodeCount: number, kind: GraphKind, mode: ThemeMode, presentation = false): StylesheetJson {
  const taskTree = kind === "task";
  const colors = themeColors[mode];
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: nodeCount > 300 ? 138 : taskTree ? 230 : 172,
        height: nodeCount > 300 ? 52 : taskTree ? 96 : 68,
        "background-color": "data(background)",
        "background-opacity": presentation ? 0 : 1,
        "border-color": "data(color)",
        "border-width": presentation ? 2.5 : 2,
        label: "data(label)",
        color: colors.text,
        "font-size": presentation ? 22 : nodeCount > 300 ? 10 : taskTree ? 11 : 12,
        "font-weight": 600,
        "font-family": presentation ? '"Chakra Petch", "Microsoft YaHei", sans-serif' : "sans-serif",
        "text-wrap": "wrap",
        "text-max-width": `${nodeCount > 300 ? 122 : taskTree ? 204 : 154}px`,
        "text-valign": "center",
        "text-halign": "center",
        "overlay-opacity": 0
      }
    },
    { selector: 'node[type="Host"]', style: { shape: "hexagon" } },
    { selector: 'node[type="Service"]', style: { shape: "round-rectangle" } },
    { selector: 'node[type="WebEndpoint"]', style: { shape: "ellipse" } },
    { selector: 'node[type="Vulnerability"]', style: { shape: "diamond" } },
    {
      selector: "node.trace-linked",
      style: { "border-width": 4, "underlay-color": "#93c5fd", "underlay-opacity": 0.38, "underlay-padding": 7 }
    },
    {
      selector: "node.is-selected",
      style: { "border-width": 4, "border-color": colors.primary, "underlay-color": colors.primary, "underlay-opacity": 0.25, "underlay-padding": 10 }
    },
    {
      selector: "node.is-neighbor",
      style: { "border-width": 3 }
    },
    {
      selector: ".is-dimmed",
      style: { opacity: 0.14, "text-opacity": 0.14 }
    },
    {
      selector: "edge",
      style: {
        width: presentation ? 2 : 1.4,
        "line-color": "data(statusColor)",
        "target-arrow-color": "data(statusColor)",
        "line-style": (element) => element.data("lineStyle"),
        "target-arrow-shape": "triangle",
        "curve-style": "taxi",
        "taxi-direction": "auto",
        "taxi-turn": 22,
        "arrow-scale": 0.8,
        opacity: (element: EdgeSingular) => element.data("statusOpacity"),
        "overlay-opacity": 0
      }
    },
    {
      selector: "edge.is-active-edge",
      style: {
        width: 2.8,
        label: "data(label)",
        color: colors.text,
        "font-size": 10,
        "font-weight": 600,
        "text-background-color": colors.surface,
        "text-background-opacity": 0.9,
        "text-background-padding": "3px",
        "text-rotation": "autorotate",
        opacity: (element: EdgeSingular) => element.data("statusOpacity")
      }
    }
  ];
}
