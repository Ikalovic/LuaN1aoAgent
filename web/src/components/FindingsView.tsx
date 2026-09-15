import { useState } from "react";
import { Button, Checkbox, Empty, Segmented, Table, Tag } from "antd";
import { Network } from "lucide-react";
import { hasFindingEvidence, type Situation } from "../situation";
import { useLanguage } from "../language";
import type { GraphNode } from "../types";
export function FindingsView({ situation, type = "all", selectedId, onTypeChange, onSelect, onGraph, compact = false }: { situation: Situation; type?: string; selectedId?: string; onTypeChange: (value: string) => void; onSelect: (id: string) => void; onGraph: (id: string) => void; compact?: boolean }) {
  const { locale, formatDate } = useLanguage();
  const zh = locale === "zh-CN";
  const [missingOnly, setMissingOnly] = useState(false);
  const priority = (node: GraphNode) => node.type === "Vulnerability" ? 0 : node.type === "Exploit" && node.properties.status === "succeeded" ? 1 : node.type === "Hypothesis" && !["confirmed", "refuted", "superseded"].includes(String(node.properties.status)) ? 2 : 3;
  const items = situation.findings.all.filter((node) => (type === "all" || node.type === type) && (!missingOnly || (!hasFindingEvidence(node) && (node.type === "Vulnerability" || node.type === "Exploit" && node.properties.status === "succeeded" || node.type === "Hypothesis" && node.properties.status === "refuted"))))
    .sort((a, b) => (compact ? priority(a) - priority(b) : 0) || (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
  const asset = (node: GraphNode) => {
    const ids = situation.edges.flatMap((edge) => edge.from === node.id ? [edge.to] : edge.to === node.id ? [edge.from] : []);
    return situation.assets.all.filter((item) => ids.includes(item.id)).map((item) => item.label).join(", ") || "--";
  };
  return <section className={`qx-findings ${compact ? "compact" : ""}`}>{!compact ? <Segmented value={type} onChange={onTypeChange} options={[{ value: "all", label: zh ? "全部" : "All" }, "Vulnerability", "Exploit", "Hypothesis"]} /> : null}{!compact ? <Checkbox checked={missingOnly} onChange={(event) => setMissingOnly(event.target.checked)}>{zh ? "缺少证据" : "Missing evidence"}</Checkbox> : null}{compact ? <div className="qx-finding-list">{items.slice(0, 6).map((node) => <button key={node.id} onClick={() => onSelect(node.id)}><span><Tag>{node.type}</Tag><small>{String(node.properties.status ?? "--")}</small></span><strong>{node.label}</strong><small>{node.evidenceRefs.filter((ref) => ref.trim()).length} {zh ? "条证据" : "evidence refs"} · {asset(node)}</small></button>)}{!items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={situation.counts.nodes.value === null ? (zh ? "数据不可用" : "Unavailable") : (zh ? "暂无发现" : "No findings")} /> : null}</div> : <Table rowKey="id" dataSource={items} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 780 }} rowClassName={(node) => node.id === selectedId ? "qx-selected-row" : ""} columns={[
    { title: zh ? "发现" : "Finding", dataIndex: "label", render: (_, node) => <Button type="link" onClick={() => onSelect(node.id)}>{node.label}</Button> },
    { title: zh ? "类型" : "Type", dataIndex: "type" },
    { title: zh ? "原始状态" : "Recorded status", render: (_, node) => String(node.properties.status ?? "--") },
    { title: zh ? "关联资产" : "Linked asset", render: (_, node) => asset(node) },
    { title: zh ? "证据" : "Evidence", render: (_, node) => node.evidenceRefs.filter((ref) => ref.trim()).length },
    { title: zh ? "时间" : "Updated", render: (_, node) => node.updatedAt ? formatDate(node.updatedAt) : "--" },
    { title: "", render: (_, node) => <Button icon={<Network size={16} />} aria-label={zh ? "查看证据关系" : "View evidence graph"} onClick={() => onGraph(node.id)} /> }
  ]} />}</section>;
}
