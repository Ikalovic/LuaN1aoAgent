import { Suspense, lazy, useMemo, useState } from "react";
import { Alert, Empty, Segmented, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import { useLanguage, type TranslationKey } from "../language";
import type { GraphEdge, GraphNode } from "../types";

const GraphView = lazy(() => import("./GraphView").then((module) => ({ default: module.GraphView })));

/**
 * Read-only view of what the information-collection Agent decided to remember.
 *
 * Memory is identified by `properties.origin`, not by node type: the projection
 * stamps every node it writes, and nodes the runtime observed on the target
 * carry no such stamp. Filtering by type instead would show target-side
 * discoveries as if they had been collected from the open internet.
 */
const MEMORY_ORIGINS = new Set(["osint", "imported"]);

/** Entity types the collection projection can produce, in display order. */
const ENTITY_TYPES = [
  "Organization", "Person", "Identity", "Contact",
  "Host", "Service", "Port", "WebEndpoint", "File"
];

const TYPE_LABELS: Record<string, { zh: string; en: string }> = {
  Organization: { zh: "组织主体", en: "Organization" },
  Person: { zh: "人员", en: "Person" },
  Identity: { zh: "邮箱/账号", en: "Identity" },
  Contact: { zh: "联系方式", en: "Contact" },
  Host: { zh: "主机/域名", en: "Host" },
  Service: { zh: "服务", en: "Service" },
  Port: { zh: "端口", en: "Port" },
  WebEndpoint: { zh: "Web 端点", en: "Web endpoint" },
  File: { zh: "文档", en: "Document" }
};

const CONFIDENCE_COLORS: Record<string, string> = {
  observed: "green",
  inferred: "blue",
  unconfirmed: "default"
};

type MemoryRow = {
  key: string;
  node: GraphNode;
  type: string;
  label: string;
  confidence: string;
  sources: string[];
  masked: boolean;
  leadOnly: boolean;
  imported: boolean;
};

export function MemoryView({ runtimeDir, nodes, edges, selectedNodeId, onSelectNode }: {
  runtimeDir: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string;
  onSelectNode: (nodeId?: string) => void;
}) {
  const { t, locale } = useLanguage();
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [confidenceFilter, setConfidenceFilter] = useState<string[]>([]);
  const [mode, setMode] = useState<"graph" | "list">("graph");

  const memoryNodes = useMemo(
    () => nodes.filter((node) => MEMORY_ORIGINS.has(String(node.properties.origin ?? ""))),
    [nodes]
  );

  const rows = useMemo<MemoryRow[]>(() => memoryNodes.map((node) => {
    const provenance = Array.isArray(node.properties.provenance) ? node.properties.provenance : [];
    const sources = [...new Set(provenance
      .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).source ?? "") : ""))
      .filter(Boolean))];
    const origin = String(node.properties.origin ?? "");
    return {
      key: node.id,
      node,
      type: node.type,
      label: node.label,
      confidence: String(node.properties.confidence ?? "unconfirmed"),
      sources,
      masked: node.properties.masked === true,
      // The projection marks out-of-scope target-side entities as candidate_only
      // with active testing withheld; that combination is the lead marker.
      leadOnly: node.properties.classification === "candidate_only"
        && node.properties.active_testing_allowed === false,
      imported: origin === "imported"
    };
  }), [memoryNodes]);

  const visibleRows = useMemo(() => rows.filter((row) => {
    if (typeFilter.length > 0 && !typeFilter.includes(row.type)) return false;
    if (confidenceFilter.length > 0 && !confidenceFilter.includes(row.confidence)) return false;
    return true;
  }), [rows, typeFilter, confidenceFilter]);

  const visibleIds = useMemo(() => new Set(visibleRows.map((row) => row.key)), [visibleRows]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    [edges, visibleIds]
  );

  const stats = useMemo(() => {
    const byType = new Map<string, number>();
    const byConfidence = new Map<string, number>();
    const bySource = new Map<string, number>();
    let masked = 0;
    let leads = 0;
    for (const row of rows) {
      byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
      byConfidence.set(row.confidence, (byConfidence.get(row.confidence) ?? 0) + 1);
      for (const source of row.sources) bySource.set(source, (bySource.get(source) ?? 0) + 1);
      if (row.masked) masked += 1;
      if (row.leadOnly) leads += 1;
    }
    return { byType, byConfidence, bySource, masked, leads };
  }, [rows]);

  const typeOptions = useMemo(
    () => ENTITY_TYPES
      .filter((type) => stats.byType.has(type))
      .map((type) => ({ value: type, label: typeLabel(type, locale) })),
    [stats.byType, locale]
  );

  if (memoryNodes.length === 0) {
    return (
      <section className="memory-view">
        <Empty description={(
          <Space orientation="vertical" size={4}>
            <Typography.Text>{t("memory.empty")}</Typography.Text>
            <Typography.Text type="secondary">{t("memory.emptyHint")}</Typography.Text>
          </Space>
        )} />
      </section>
    );
  }

  return (
    <section className="memory-view">
      <header className="memory-summary">
        <Space size={28} wrap>
          <Statistic title={t("memory.total")} value={rows.length} />
          <Statistic title={t("memory.observed")} value={stats.byConfidence.get("observed") ?? 0} />
          <Statistic title={t("memory.inferred")} value={stats.byConfidence.get("inferred") ?? 0} />
          <Statistic title={t("memory.unconfirmed")} value={stats.byConfidence.get("unconfirmed") ?? 0} />
        </Space>
        <Space size={8} wrap className="memory-badges">
          {[...stats.byType.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([type, count]) => (
              <Tag key={type}>{typeLabel(type, locale)} {count}</Tag>
            ))}
          {[...stats.bySource.entries()].map(([source, count]) => (
            <Tag key={source} color="geekblue">{source} {count}</Tag>
          ))}
          {stats.masked > 0 ? <Tag color="purple">{t("memory.masked", { value: stats.masked })}</Tag> : null}
          {stats.leads > 0 ? <Tag color="orange">{t("memory.leadsOnly", { value: stats.leads })}</Tag> : null}
        </Space>
      </header>

      {stats.leads > 0 ? (
        <Alert type="warning" showIcon title={t("memory.leadsOnlyHint")} className="memory-lead-alert" />
      ) : null}

      <div className="memory-toolbar">
        <Segmented
          value={mode}
          onChange={(next) => setMode(next as "graph" | "list")}
          options={[
            { value: "graph", label: t("memory.showGraph") },
            { value: "list", label: t("memory.showTable") }
          ]}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t("memory.filterType")}
          aria-label={t("memory.filterType")}
          value={typeFilter}
          options={typeOptions}
          onChange={setTypeFilter}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t("memory.filterConfidence")}
          aria-label={t("memory.filterConfidence")}
          value={confidenceFilter}
          options={[
            { value: "observed", label: t("memory.observed") },
            { value: "inferred", label: t("memory.inferred") },
            { value: "unconfirmed", label: t("memory.unconfirmed") }
          ]}
          onChange={setConfidenceFilter}
        />
      </div>

      {mode === "graph" ? (
        <div className="memory-graph">
          <Suspense fallback={null}>
            <GraphView
              runtimeDir={runtimeDir}
              kind="operation"
              nodes={visibleRows.map((row) => row.node)}
              edges={visibleEdges}
              selectedNodeId={selectedNodeId}
              linkedNodeIds={[]}
              onSelectNode={onSelectNode}
            />
          </Suspense>
        </div>
      ) : (
        <Table<MemoryRow>
          size="small"
          rowKey="key"
          dataSource={visibleRows}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          onRow={(row) => ({ onClick: () => onSelectNode(row.key) })}
          columns={[
            {
              title: t("memory.table.entity"),
              dataIndex: "label",
              render: (_value, row) => (
                <Space orientation="vertical" size={0}>
                  <Typography.Text strong>{row.label}</Typography.Text>
                  <Typography.Text type="secondary" className="memory-row-id">{row.node.id}</Typography.Text>
                </Space>
              )
            },
            {
              title: t("memory.table.type"),
              dataIndex: "type",
              width: 140,
              filters: typeOptions.map((option) => ({ text: option.label, value: option.value })),
              onFilter: (value, row) => row.type === value,
              render: (value: string) => <Tag>{typeLabel(value, locale)}</Tag>
            },
            {
              title: t("memory.table.confidence"),
              dataIndex: "confidence",
              width: 120,
              render: (value: string) => (
                <Tag color={CONFIDENCE_COLORS[value] ?? "default"}>{confidenceLabel(value, t)}</Tag>
              )
            },
            {
              title: t("memory.table.provenance"),
              dataIndex: "sources",
              render: (value: string[]) => value.length > 0
                ? <Space size={4} wrap>{value.map((source) => <Tag key={source} color="geekblue">{source}</Tag>)}</Space>
                : <Typography.Text type="secondary">{t("memory.noProvenance")}</Typography.Text>
            },
            {
              title: t("memory.table.flags"),
              key: "flags",
              width: 200,
              render: (_value, row) => (
                <Space size={4} wrap>
                  {row.leadOnly ? <Tag color="orange">{t("memory.flagLead")}</Tag> : null}
                  {row.masked ? <Tag color="purple">{t("memory.flagMasked")}</Tag> : null}
                  {row.imported ? <Tag color="cyan">{t("memory.flagImported")}</Tag> : null}
                </Space>
              )
            }
          ]}
        />
      )}
    </section>
  );
}

function typeLabel(type: string, locale: string): string {
  const entry = TYPE_LABELS[type];
  if (!entry) return type;
  return locale === "en-US" ? entry.en : entry.zh;
}

function confidenceLabel(value: string, t: (key: TranslationKey) => string): string {
  // Unknown values fall through to the raw tag rather than rendering blank, so a
  // future confidence level surfaces instead of disappearing.
  const keys: Record<string, TranslationKey> = {
    observed: "memory.observed",
    inferred: "memory.inferred",
    unconfirmed: "memory.unconfirmed"
  };
  const key = keys[value];
  return key ? t(key) : value;
}
