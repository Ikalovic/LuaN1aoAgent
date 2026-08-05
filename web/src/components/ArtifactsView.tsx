import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Segmented, Skeleton, Tag, Typography } from "antd";
import { Download, FileArchive, FileText, Image as ImageIcon, ListChecks } from "lucide-react";
import { fetchArtifact } from "../api";
import { useLanguage } from "../language";
import type { ArtifactContent, ArtifactRecord, EpochOutcome, FinalReport as FinalReportData, RunFinalResult, TaskOutcome, TaskSummary } from "../types";
import { shortRef } from "../utils";
import { Markdown, looksLikeMarkdown } from "./Markdown";
import { StructuredReport } from "./StructuredReport";

type ReportTab = "final" | "tasks" | "artifacts";

export function ArtifactsView(props: {
  runtimeDir: string;
  artifacts: ArtifactRecord[];
  taskOutcomes: TaskOutcome[];
  epochOutcomes: EpochOutcome[];
  latestTaskOutcome?: TaskOutcome;
  finalResult?: RunFinalResult;
  finalReport?: FinalReportData;
  tasks: TaskSummary[];
}) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [tab, setTab] = useState<ReportTab>("final");
  const [selectedRef, setSelectedRef] = useState<string>();
  const artifactMap = useMemo(() => new Map(props.artifacts.map((artifact) => [artifact.artifactRef, artifact])), [props.artifacts]);
  const taskMap = useMemo(() => new Map(props.tasks.map((task) => [task.id, task])), [props.tasks]);

  return (
    <div className="reports-view">
      <div className="reports-toolbar">
        <Segmented
          value={tab}
          onChange={(value) => setTab(value as ReportTab)}
          options={[
            { value: "final", label: zh ? "最终结果" : "Final result", icon: <FileText size={15} /> },
            { value: "tasks", label: zh ? "任务结果" : "Task results", icon: <ListChecks size={15} /> },
            { value: "artifacts", label: zh ? "全部产物" : "All artifacts", icon: <FileArchive size={15} /> }
          ]}
        />
        <span>{zh ? "内容按类型解析；原始文本始终可切换查看。" : "Content is parsed by type; raw text remains available."}</span>
      </div>

      {tab === "final" ? (
        <FinalResult
          report={props.finalReport}
          finalResult={props.finalResult}
          outcome={props.latestTaskOutcome}
          artifacts={props.latestTaskOutcome?.artifactRefs.flatMap((ref) => artifactMap.get(ref) ?? []) ?? []}
          taskLabel={props.latestTaskOutcome ? taskMap.get(props.latestTaskOutcome.taskRef)?.label : undefined}
          onOpenArtifact={setSelectedRef}
          zh={zh}
        />
      ) : tab === "tasks" ? (
        <TaskResults
          taskOutcomes={props.taskOutcomes}
          epochOutcomes={props.epochOutcomes}
          taskMap={taskMap}
          onOpenArtifact={setSelectedRef}
          artifactMap={artifactMap}
          zh={zh}
        />
      ) : (
        <ArtifactList artifacts={props.artifacts} onOpenArtifact={setSelectedRef} zh={zh} />
      )}

      <ArtifactPreview
        runtimeDir={props.runtimeDir}
        artifact={selectedRef ? artifactMap.get(selectedRef) : undefined}
        artifactRef={selectedRef}
        onClose={() => setSelectedRef(undefined)}
        zh={zh}
      />
    </div>
  );
}

function FinalResult({ report, finalResult, outcome, artifacts, taskLabel, onOpenArtifact, zh }: {
  report?: FinalReportData;
  finalResult?: RunFinalResult;
  outcome?: TaskOutcome;
  artifacts: ArtifactRecord[];
  taskLabel?: string;
  onOpenArtifact: (ref: string) => void;
  zh: boolean;
}) {
  if (report) {
    return (
      <div className="report-stack">
        <section className="outcome-card final-outcome">
          <div className="outcome-heading">
            <div>
              <span>{zh ? "Report Artifact · 最终交付物" : "Report Artifact · final deliverable"}</span>
              <Typography.Title level={4}>{zh ? "最终报告" : "Final report"}</Typography.Title>
            </div>
            <Tag color="success">{zh ? "已生成" : "generated"}</Tag>
          </div>
          <Alert
            type="success"
            showIcon
            message={zh ? "报告任务已完成，以下文件已持久化，可解析预览或下载。" : "The report task completed and persisted the following file for preview or download."}
          />
          <StructuredReport text={report.summary} />
          <dl className="outcome-details">
            <div><dt>{zh ? "报告任务" : "Report task"}</dt><dd>{report.taskRef}</dd></div>
            <div><dt>{zh ? "完成时间" : "Completed at"}</dt><dd>{report.createdAt}</dd></div>
            <div><dt>{zh ? "报告文件" : "Report files"}</dt><dd>{report.artifactRefs.length}</dd></div>
          </dl>
        </section>
        <section className="linked-artifacts">
          <Typography.Title level={5}>{zh ? "报告文件" : "Report files"}</Typography.Title>
          {report.artifacts.map((artifact) => (
            <ArtifactButton key={artifact.artifactRef} artifact={artifact} onOpen={onOpenArtifact} />
          ))}
        </section>
      </div>
    );
  }
  if (finalResult) {
    return (
      <div className="report-stack">
        <section className="outcome-card final-outcome">
          <div className="outcome-heading">
            <div>
              <span>{zh ? "运行总结 · Planner 终态决策" : "Run summary · terminal Planner decision"}</span>
              <Typography.Title level={4}>{zh ? "最终结果" : "Final result"}</Typography.Title>
            </div>
            <Tag color="success">{zh ? "已收敛" : "converged"}</Tag>
          </div>
          <Alert
            type="success"
            showIcon
            message={zh ? "这是运行结束时持久化的总体结论，不代表生成了独立报告文件。" : "This is the persisted run-wide conclusion; it does not imply a standalone report file exists."}
          />
          <StructuredReport text={finalResult.summary} />
          <dl className="outcome-details">
            <div><dt>{zh ? "来源事件" : "Source event"}</dt><dd>{finalResult.sourceEventId}</dd></div>
            <div><dt>{zh ? "完成时间" : "Completed at"}</dt><dd>{finalResult.createdAt}</dd></div>
          </dl>
        </section>
      </div>
    );
  }
  if (!outcome) {
    return <Empty description={zh ? "任务尚未产生 TaskOutcome；运行完成后这里会展示结构化结论。" : "No TaskOutcome has been produced yet."} />;
  }
  return (
    <div className="report-stack">
      <section className="outcome-card final-outcome">
        <OutcomeHeading outcome={outcome} taskLabel={taskLabel} zh={zh} />
        <Alert
          type="info"
          showIcon
          message={zh ? "这是最后更新的 TaskOutcome，不代表一定生成了独立报告文件。" : "This is the latest TaskOutcome; it does not imply a standalone report file exists."}
        />
        <StructuredReport text={outcome.summary} />
        <OutcomeDetails outcome={outcome} zh={zh} />
      </section>
      <section className="linked-artifacts">
        <Typography.Title level={5}>{zh ? "关联产物" : "Linked artifacts"}</Typography.Title>
        {artifacts.length ? artifacts.map((artifact) => (
          <ArtifactButton key={artifact.artifactRef} artifact={artifact} onOpen={onOpenArtifact} />
        )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? "该 TaskOutcome 未引用独立产物文件" : "This TaskOutcome does not reference a standalone artifact"} />}
      </section>
    </div>
  );
}

function TaskResults({ taskOutcomes, epochOutcomes, taskMap, artifactMap, onOpenArtifact, zh }: {
  taskOutcomes: TaskOutcome[];
  epochOutcomes: EpochOutcome[];
  taskMap: Map<string, TaskSummary>;
  artifactMap: Map<string, ArtifactRecord>;
  onOpenArtifact: (ref: string) => void;
  zh: boolean;
}) {
  if (!taskOutcomes.length && !epochOutcomes.length) {
    return <Empty description={zh ? "暂无任务结果" : "No task results"} />;
  }
  const taskRefs = [...new Set([...taskOutcomes.map((item) => item.taskRef), ...epochOutcomes.map((item) => item.taskRef)])];
  return <div className="report-stack">{taskRefs.map((taskRef) => {
    const outcome = taskOutcomes.find((item) => item.taskRef === taskRef);
    const epochs = epochOutcomes.filter((item) => item.taskRef === taskRef).sort((a, b) => a.terminalSeq - b.terminalSeq);
    return (
      <section className="outcome-card" key={taskRef}>
        {outcome ? <OutcomeHeading outcome={outcome} taskLabel={taskMap.get(taskRef)?.label} zh={zh} /> : (
          <div className="outcome-heading"><div><span>{shortRef(taskRef, 36)}</span><Typography.Title level={4}>{taskMap.get(taskRef)?.label || taskRef}</Typography.Title></div></div>
        )}
        {epochs.length ? <div className="epoch-strip">{epochs.map((epoch, index) => (
          <div className="epoch-item" key={epoch.epochRef}>
            <span>{zh ? `执行轮次 ${index + 1}` : `Epoch ${index + 1}`}</span>
            <Tag color={statusColor(epoch.status)}>{epoch.status}</Tag>
            <p>{epoch.reason}</p>
            <small>{shortRef(epoch.epochRef, 28)}</small>
          </div>
        ))}</div> : null}
        {outcome ? <>
          <StructuredReport text={outcome.summary} />
          <OutcomeDetails outcome={outcome} zh={zh} />
          {outcome.artifactRefs.length ? <div className="outcome-artifacts">{outcome.artifactRefs.map((ref) => (
            <ArtifactButton key={ref} artifact={artifactMap.get(ref) ?? { artifactRef: ref }} onOpen={onOpenArtifact} />
          ))}</div> : null}
        </> : null}
      </section>
    );
  })}</div>;
}

function OutcomeHeading({ outcome, taskLabel, zh }: { outcome: TaskOutcome; taskLabel?: string; zh: boolean }) {
  return (
    <div className="outcome-heading">
      <div>
        <span>{zh ? "TaskOutcome · 最新结论" : "TaskOutcome · latest conclusion"}</span>
        <Typography.Title level={4}>{taskLabel || shortRef(outcome.taskRef, 48)}</Typography.Title>
      </div>
      <Tag color={statusColor(outcome.status)}>{outcome.status}</Tag>
    </div>
  );
}

function OutcomeDetails({ outcome, zh }: { outcome: TaskOutcome; zh: boolean }) {
  return (
    <dl className="outcome-details">
      <div><dt>{zh ? "任务引用" : "Task ref"}</dt><dd>{outcome.taskRef}</dd></div>
      <div><dt>{zh ? "最终执行轮次" : "Final epoch"}</dt><dd>{outcome.epochRef}</dd></div>
      <div><dt>{zh ? "证据" : "Evidence"}</dt><dd>{outcome.evidenceRefs.length}</dd></div>
      <div><dt>{zh ? "产物" : "Artifacts"}</dt><dd>{outcome.artifactRefs.length}</dd></div>
      {outcome.blockerReason ? <div><dt>{zh ? "阻塞原因" : "Blocker"}</dt><dd>{outcome.blockerReason}</dd></div> : null}
      {outcome.suggestedNextGoal ? <div><dt>{zh ? "建议下一目标" : "Suggested next goal"}</dt><dd>{outcome.suggestedNextGoal}</dd></div> : null}
    </dl>
  );
}

function ArtifactList({ artifacts, onOpenArtifact, zh }: { artifacts: ArtifactRecord[]; onOpenArtifact: (ref: string) => void; zh: boolean }) {
  if (!artifacts.length) return <Empty description={zh ? "暂无产物" : "No artifacts"} />;
  return <div className="artifact-grid">{artifacts.map((artifact) => (
    <ArtifactButton key={artifact.artifactRef} artifact={artifact} onOpen={onOpenArtifact} />
  ))}</div>;
}

function ArtifactButton({ artifact, onOpen }: { artifact: ArtifactRecord; onOpen: (ref: string) => void }) {
  const isImage = artifact.mediaType?.startsWith("image/");
  return (
    <button className="artifact-card" type="button" onClick={() => onOpen(artifact.artifactRef)}>
      <span className="artifact-card-icon">{isImage ? <ImageIcon size={18} /> : <FileText size={18} />}</span>
      <span className="artifact-card-copy">
        <strong>{artifact.path?.split("/").at(-1) || shortRef(artifact.artifactRef, 34)}</strong>
        <small>{artifact.kind || artifact.mediaType || "artifact"}{artifact.taskId ? ` · ${shortRef(artifact.taskId, 18)}` : ""}</small>
      </span>
      <Tag>{artifact.byteLength ? formatBytes(artifact.byteLength) : "—"}</Tag>
    </button>
  );
}

function ArtifactPreview({ runtimeDir, artifactRef, artifact, onClose, zh }: {
  runtimeDir: string;
  artifactRef?: string;
  artifact?: ArtifactRecord;
  onClose: () => void;
  zh: boolean;
}) {
  const [content, setContent] = useState<ArtifactContent>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!artifactRef) return;
    const controller = new AbortController();
    setContent(undefined);
    setError(undefined);
    setLoading(true);
    fetchArtifact(runtimeDir, artifactRef, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setContent(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [artifactRef, runtimeDir]);

  if (!artifactRef) return null;
  const mediaType = content?.mediaType || artifact?.mediaType || "";
  return (
    <div className="artifact-preview-panel" role="dialog" aria-label={zh ? "产物预览" : "Artifact preview"}>
      <div className="artifact-preview-head">
        <div><span>{zh ? "解析预览" : "Parsed preview"}</span><strong>{artifact?.path?.split("/").at(-1) || shortRef(artifactRef, 42)}</strong></div>
        <div>
          {content ? <Button icon={<Download size={15} />} onClick={() => downloadArtifact(content)}>{zh ? "下载" : "Download"}</Button> : null}
          <Button onClick={onClose}>{zh ? "关闭" : "Close"}</Button>
        </div>
      </div>
      {loading ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {content ? <ParsedArtifact content={content} mediaType={mediaType} zh={zh} /> : null}
    </div>
  );
}

function ParsedArtifact({ content, mediaType, zh }: { content: ArtifactContent; mediaType: string; zh: boolean }) {
  if (mediaType.startsWith("image/") && content.encoding === "base64") {
    return <img className="artifact-preview-image" src={`data:${mediaType};base64,${content.content}`} alt={content.artifactRef} />;
  }
  if (content.encoding === "base64") {
    return <Alert type="info" showIcon message={zh ? "二进制产物仅展示元数据，请下载后查看。" : "Binary artifact: download to inspect."} description={`${mediaType || "application/octet-stream"} · ${formatBytes(content.byteLength ?? 0)}`} />;
  }
  if (/json/i.test(mediaType) || content.content.trim().startsWith("{") || content.content.trim().startsWith("[")) {
    try {
      return <JsonTree value={JSON.parse(content.content) as unknown} />;
    } catch {
      // Keep malformed JSON visible through the structured/raw text renderer.
    }
  }
  if (/markdown/i.test(mediaType) || looksLikeMarkdown(content.content)) return <Markdown text={content.content} />;
  return <StructuredReport text={content.content} />;
}

function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || typeof value !== "object") return <code className="json-leaf">{JSON.stringify(value)}</code>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  return <div className={`json-tree depth-${Math.min(depth, 4)}`}>{entries.map(([key, child]) => (
    <div className="json-tree-row" key={key}><strong>{key}</strong><div><JsonTree value={child} depth={depth + 1} /></div></div>
  ))}</div>;
}

function downloadArtifact(content: ArtifactContent) {
  const bytes = content.encoding === "base64"
    ? Uint8Array.from(atob(content.content), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(content.content);
  const url = URL.createObjectURL(new Blob([bytes], { type: content.mediaType || "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = content.artifactRef.replace("artifact:", "") || "artifact";
  anchor.click();
  URL.revokeObjectURL(url);
}

function statusColor(status: string): string {
  if (status === "completed" || status === "submitted") return "success";
  if (status === "partial" || status === "checkpointed") return "processing";
  if (status === "blocked" || status === "provider_error") return "warning";
  return "error";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
