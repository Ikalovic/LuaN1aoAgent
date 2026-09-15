import { lazy, Suspense, useMemo } from "react";
import { Empty, Skeleton } from "antd";
import { bucketActivity } from "../situation";
import type { CollectionCoverage, JsonRecord } from "../types";
import type { NavigationState } from "../navigation";
import { useTheme } from "../ThemeProvider";
import { themeColors } from "../theme";
import { useLanguage } from "../language";
const Column = lazy(() => import("@ant-design/charts").then((module) => ({ default: module.Column })));
export function activityOptions(range: Pick<NavigationState, "range" | "from" | "to">, now?: string) {
  return { now, start: range.range === "custom" ? range.from : undefined, end: range.range === "custom" ? range.to : undefined, relativeMs: ({ "15m": 900_000, "1h": 3_600_000, "24h": 86_400_000 } as Record<string, number>)[range.range ?? "loaded"] };
}
export function ActivityChart({ events, coverage, now, range, onRange, compact = false }: { events: JsonRecord[]; coverage?: CollectionCoverage; now?: string; range: NavigationState; onRange: (from: string, to: string) => void; compact?: boolean }) {
  const { mode } = useTheme();
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const activity = useMemo(() => bucketActivity(events, activityOptions(range, now)), [events, range.range, range.from, range.to, now]);
  const buckets = coverage?.state === "complete" ? activity.buckets : activity.buckets.filter((bucket) => bucket.count > 0);
  const colors = themeColors[mode];
  if (compact) return <section className="wall-activity"><header><h3>{zh ? "事件活动" : "Event activity"}</h3><span>{coverage?.state === "complete" ? "完整" : coverage?.state === "partial" ? "部分已加载" : "覆盖未知"} · UTC</span></header>{buckets.length ? <><div className="wall-activity-bars" role="group" aria-label="事件时间分布">{buckets.map((bucket) => <button key={bucket.start} aria-label={`${bucket.start} 至 ${bucket.end}: ${bucket.count}`} title={`${bucket.start.slice(11, 19)} · ${bucket.count}`} style={{ height: `${Math.max(3, bucket.count / Math.max(1, ...buckets.map((b) => b.count)) * 100)}%` }} onClick={() => onRange(bucket.start, bucket.end)} />)}</div><div className="wall-activity-axis"><time>{buckets[0].start.slice(11, 19)}</time><time>{buckets.at(-1)!.end.slice(11, 19)}</time></div></> : <p className="wall-empty">此时间范围没有已加载事件</p>}</section>;
  return <section className="qx-activity"><header><h3>{zh ? "事件活动" : "Event activity"}</h3><span>{coverage?.state === "complete" ? (zh ? "完整" : "Complete") : coverage?.state === "partial" ? (zh ? "部分已加载" : "Partially loaded") : (zh ? "覆盖未知" : "Coverage unknown")} · UTC</span></header>{buckets.length ? <><div className="qx-activity-chart"><Suspense fallback={<Skeleton active />}><Column data={buckets} xField="start" yField="count" height={180} theme={mode} padding={[16, 12, 32, 34]} style={{ fill: colors.primary }} axis={{ x: { labelFormatter: (value: string) => new Date(value).toISOString().slice(11, 19), labelAutoHide: true }, y: { title: false } }} tooltip={{ title: "start" }} onReady={({ chart }: any) => { chart.on("element:click", (event: any) => { const datum = event.data?.data; if (datum?.start && datum?.end) onRange(datum.start, datum.end); }); }} /></Suspense></div><details className="qx-activity-data"><summary>{zh ? "活动数据" : "Activity data"}</summary>{buckets.map((bucket) => <button key={bucket.start} onClick={() => onRange(bucket.start, bucket.end)}>{bucket.start} · {bucket.count}</button>)}</details></> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? "此时间范围没有已加载事件" : "No loaded events in this range"} />}</section>;
}
