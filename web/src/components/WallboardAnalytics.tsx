import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { bucketActivity, TASK_STATUSES, type CountMetric, type Situation } from "../situation";
import type { RuntimeState } from "../types";
import type { NavigationState } from "../navigation";
import { activityOptions } from "./ActivityChart";

const Pie = lazy(() => import("@ant-design/charts").then((module) => ({ default: module.Pie })));
const Line = lazy(() => import("@ant-design/charts").then((module) => ({ default: module.Line })));
const taskLabels = ["待执行", "已完成", "阻塞", "失败", "已归档", "未知"];
const taskColors = ["#71b9f5", "#64e4c5", "#efc679", "#f17f8e", "#677d90", "#b7c1ce"];
const assetColors = ["#71b9f5", "#64e4c5", "#efc679"];
const number = (metric: CountMetric) => metric.value === null ? "--" : metric.value;
const coverageText = (metric: CountMetric) => metric.state === "complete" ? "当前快照" : metric.state === "unavailable" ? "数据不可用" : "已加载 · 部分或覆盖未知";

function useChartHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(140);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setHeight(Math.max(40, Math.round(entry.contentRect.height))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

function Distribution({ title, rows, colors, center, caption, scope }: { title: string; rows: Array<{ label: string; metric: CountMetric }>; colors: string[]; center: string | number; caption: string; scope: string }) {
  const { ref, height } = useChartHeight();
  const values = rows.map(({ label, metric }) => ({ label, value: metric.value ?? 0 })).filter((row) => row.value > 0);
  return <section className="wall-distribution">
    <header><h2>{title}</h2><span>{scope}</span></header>
    <div className="wall-distribution-body">
      <div className="wall-donut" ref={ref}>
        {values.length ? <Suspense fallback={null}><Pie data={values} height={height} autoFit angleField="value" colorField="label" innerRadius={0.8} radius={0.88} padding={0} margin={0} legend={false} label={false} animate={false} theme="dark" scale={{ color: { domain: rows.map((row) => row.label), range: colors } }} style={{ stroke: "transparent", inset: 1.5, fillOpacity: 0.95, shadowColor: "#6bcfc655", shadowBlur: 6 }} /></Suspense> : <div className="wall-donut-empty" />}
        <div className="wall-donut-center"><strong>{center}</strong><span>{caption}</span></div>
      </div>
      <div className="wall-chart-legend">{rows.map((row, index) => <div key={row.label}><i style={{ backgroundColor: colors[index] }} /><span>{row.label}</span><strong>{number(row.metric)}</strong></div>)}</div>
    </div>
  </section>;
}

export function WallboardDistributions({ situation }: { situation: Situation }) {
  const assets = [situation.assets.hosts, situation.assets.services, situation.assets.webEndpoints];
  return <>
    <Distribution title="任务推进" rows={TASK_STATUSES.map((status, index) => ({ label: taskLabels[index], metric: situation.tasks.byStatus[status] }))} colors={taskColors} center={situation.tasks.completion === null ? "--" : `${Math.round(situation.tasks.completion * 100)}%`} caption="完成 / 非归档" scope={coverageText(situation.tasks.total)} />
    <Distribution title="资产构成" rows={assets.map((metric, index) => ({ metric, label: ["主机", "服务", "Web 端点"][index] }))} colors={assetColors} center={assets.some((metric) => metric.value === null) ? "--" : assets.reduce((sum, metric) => sum + metric.value!, 0)} caption="已加载资产" scope={coverageText(situation.assets.hosts)} />
  </>;
}

export function WallboardTrend({ data, navigation }: { data?: RuntimeState; navigation: NavigationState }) {
  const { ref, height } = useChartHeight();
  const activity = useMemo(() => bucketActivity(data?.events ?? [], { ...activityOptions(navigation, data?.loadedAt), bucketCount: 24 }), [data, navigation.range, navigation.from, navigation.to]);
  const complete = data?.coverage?.events.state === "complete";
  const buckets = complete ? activity.buckets : activity.buckets.filter((bucket) => bucket.count > 0);
  return <section className="wall-trend">
    <header><h2>事件趋势</h2><span>{complete ? "已加载范围" : "部分或覆盖未知"} · UTC</span></header>
    <div className="wall-trend-plot" ref={ref}>
      {buckets.length ? <Suspense fallback={null}><Line data={buckets} height={height} autoFit xField="start" yField="count" animate={false} theme="dark" paddingLeft={30} paddingRight={10} paddingTop={12} paddingBottom={26} style={{ stroke: "#64e4c5", lineWidth: 2.5, shadowColor: "#64e4c5", shadowBlur: 5 }} point={{ size: 2, style: { fill: "#c5fff0", stroke: "#64e4c5" } }} axis={{ x: { title: false, labelFormatter: (value: string) => value.slice(11, 19), labelAutoHide: true, labelFill: "#9bb8c3", line: true, lineStroke: "#35535d" }, y: { title: false, labelFill: "#9bb8c3", grid: true, gridStroke: "#507380", gridStrokeOpacity: 0.2, gridLineDash: [3, 5] } }} tooltip={{ title: "start" }} /></Suspense> : <p className="wall-empty">此时间范围没有已加载事件</p>}
    </div>
  </section>;
}
