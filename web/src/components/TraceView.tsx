import { useState } from "react";
import { Alert, Button, Collapse, Empty, Segmented, Tag, Typography } from "antd";
import { Activity, ArrowDownUp, BrainCircuit, Check, CheckCircle2, ChevronDown, Clock3, ListChecks, ListTree, LoaderCircle, PlayCircle, Rows3, TerminalSquare, XCircle } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { useLanguage, type Locale } from "../language";
import type { EpochOutcome, PlannerCheckpoint, Role, TaskOutcome, TaskSummary, TraceItem } from "../types";
import { formatRelative, formatTime, roleLabel, shortRef } from "../utils";

interface TraceViewProps {
  items: TraceItem[];
  planningCheckpoints: PlannerCheckpoint[];
  taskOutcomes: TaskOutcome[];
  epochOutcomes: EpochOutcome[];
  tasks: TaskSummary[];
  selectedTraceId?: string;
  roleFilter: string;
  newestFirst: boolean;
  onRoleFilterChange: (role: string) => void;
  onOrderChange: () => void;
  onSelectTrace: (traceId: string) => void;
}

export function TraceView(props: TraceViewProps) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<"plan" | "timeline">("plan");
  const roleOptions = [
    { label: t("trace.all"), value: "all" },
    { label: "Planner", value: "planner" },
    { label: "Executor", value: "executor" },
    { label: "Observer", value: "observer" }
  ];
  const filtered = props.items
    .filter((item) => item.role !== "runtime")
    .filter((item) => props.roleFilter === "all" || item.role === props.roleFilter)
    .sort((left, right) => {
      const diff = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
      return props.newestFirst ? -diff : diff;
    });

  return (
    <div className="trace-view">
      <div className="trace-toolbar">
        <Segmented
          value={mode}
          onChange={(value) => setMode(value as "plan" | "timeline")}
          options={[
            { value: "plan", label: "规划视图", icon: <ListTree size={15} /> },
            { value: "timeline", label: "时间线", icon: <Rows3 size={15} /> }
          ]}
        />
        <div className="trace-toolbar-actions">
          <Segmented options={roleOptions} value={props.roleFilter} onChange={(value) => props.onRoleFilterChange(String(value))} />
          {mode === "timeline" ? <Button icon={<ArrowDownUp size={16} />} onClick={props.onOrderChange}>
            {t(props.newestFirst ? "trace.newestFirst" : "trace.chronological")}
          </Button> : null}
        </div>
      </div>
      <div className="trace-list-wrap">
        {mode === "plan" ? (
          <PlanningTrace
            {...props}
            filtered={filtered}
          />
        ) : filtered.length ? (
          <Virtuoso
            data={filtered}
            increaseViewportBy={500}
            itemContent={(_, item) => (
              <TraceCard
                item={item}
                selected={item.id === props.selectedTraceId}
                onSelect={() => props.onSelectTrace(item.id)}
              />
            )}
          />
        ) : <Empty description={t("trace.empty")} />}
      </div>
    </div>
  );
}

function PlanningTrace(props: TraceViewProps & { filtered: TraceItem[] }) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  if (!props.planningCheckpoints.length) {
    return <Empty description={zh ? "Planner 尚未提交可展示的决策，可切换到时间线查看当前活动。" : "Planner has not submitted a decision yet; switch to Timeline to inspect current activity."} />;
  }
  const visibleIds = new Set(props.filtered.map((item) => item.id));
  const itemMap = new Map(props.items.map((item) => [item.id, item]));
  const taskMap = new Map(props.tasks.map((task) => [task.id, task]));
  const outcomeMap = new Map(props.taskOutcomes.map((outcome) => [outcome.taskRef, outcome]));
  const selectedCheckpoint = props.planningCheckpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId)
    || props.planningCheckpoints[props.planningCheckpoints.length - 1];
  const checkpointItems = selectedCheckpoint.traceItemIds.flatMap((id) => {
    const item = itemMap.get(id);
    return item && visibleIds.has(id) ? [item] : [];
  });
  const taskRefs = selectedCheckpoint.taskRefs.filter((taskRef) => (
    props.roleFilter === "all"
    || checkpointItems.some((item) => item.taskId === taskRef)
  ));
  const title = checkpointTitle(selectedCheckpoint, zh);
  const selectedCheckpointPosition = props.planningCheckpoints.findIndex((checkpoint) => checkpoint.id === selectedCheckpoint.id);

  return (
    <div className="planning-workbench">
      <nav className="planning-decision-index" aria-label={zh ? "Planner 决策索引" : "Planner decision index"}>
        <header>
          <div>
            <span>{zh ? "Planner 日志" : "Planner journal"}</span>
            <strong>{zh ? "决策索引" : "Decision index"}</strong>
          </div>
          <b>{props.planningCheckpoints.length}</b>
        </header>
        <div className="planning-decision-index-list">
        {props.planningCheckpoints.map((checkpoint, index) => {
          const selected = checkpoint.id === selectedCheckpoint.id;
          return (
            <button
              type="button"
              className={`planning-decision-index-item${selected ? " selected" : ""}`}
              key={checkpoint.id}
              onClick={() => setSelectedCheckpointId(checkpoint.id)}
              aria-pressed={selected}
            >
              <span className="planning-decision-marker">
                <i>{String(checkpoint.index).padStart(2, "0")}</i>
                {index < props.planningCheckpoints.length - 1 ? <b aria-hidden /> : null}
              </span>
              <span className="planning-decision-index-copy">
                <span>
                  <em>{checkpointKindLabel(checkpoint.kind, zh)}</em>
                  <time>{formatTime(checkpoint.startedAt)}</time>
                </span>
                <strong>{checkpointTitle(checkpoint, zh)}</strong>
                <small>{checkpoint.reason || (zh ? "任务图状态检查" : "Task graph state check")}</small>
                <span className="planning-decision-delta">
                  {checkpoint.inputTaskRefs.length ? <i>{zh ? `输入 ${checkpoint.inputTaskRefs.length}` : `${checkpoint.inputTaskRefs.length} inputs`}</i> : null}
                  {checkpoint.createdTaskRefs.length ? <i>{zh ? `新建 ${checkpoint.createdTaskRefs.length}` : `${checkpoint.createdTaskRefs.length} created`}</i> : null}
                  {checkpoint.updatedTaskRefs.length ? <i>{zh ? `更新 ${checkpoint.updatedTaskRefs.length}` : `${checkpoint.updatedTaskRefs.length} updated`}</i> : null}
                </span>
              </span>
            </button>
          );
        })}
        </div>
      </nav>

      <section className="planning-decision-canvas">
        <header className="planning-decision-hero">
          <div className="planning-decision-hero-copy">
            <span className="planning-decision-eyebrow">
              {zh ? `Planner 检查点 ${selectedCheckpointPosition + 1} / ${props.planningCheckpoints.length}` : `Planner checkpoint ${selectedCheckpointPosition + 1} / ${props.planningCheckpoints.length}`}
            </span>
            <div>
              <span className="planning-decision-seal">{String(selectedCheckpoint.index).padStart(2, "0")}</span>
              <div>
                <h2>{title}</h2>
                <p>{selectedCheckpoint.reason || (zh ? "Planner 已完成本次任务图状态检查。" : "Planner completed this task-graph state check.")}</p>
              </div>
            </div>
          </div>
          <div className="planning-decision-hero-meta">
            <Tag color={selectedCheckpoint.kind === "terminal" ? "success" : "blue"}>
              {checkpointKindLabel(selectedCheckpoint.kind, zh)}
            </Tag>
            <span>
              <time>{formatTime(selectedCheckpoint.startedAt)}</time>
              <small>{selectedCheckpoint.status}</small>
            </span>
          </div>
        </header>

        <div className="planning-decision-facts">
          <DecisionMetric label={zh ? "结果输入" : "Outcome inputs"} value={selectedCheckpoint.inputTaskRefs.length} />
          <DecisionMetric label={zh ? "新建任务" : "Created"} value={selectedCheckpoint.createdTaskRefs.length} />
          <DecisionMetric label={zh ? "状态更新" : "Updated"} value={selectedCheckpoint.updatedTaskRefs.length} />
          <DecisionMetric label={zh ? "活跃任务" : "Active tasks"} value={selectedCheckpoint.executionTaskRefs.length} />
        </div>

        <div className="planning-decision-body">
          <div className="planning-tasks-pane">
            <section className="planning-input-note">
              <span>{zh ? "本次决策依据" : "Decision inputs"}</span>
              {selectedCheckpoint.inputTaskRefs.length ? (
                <div>
                  {selectedCheckpoint.inputTaskRefs.map((taskRef) => (
                    <span key={taskRef}>
                      <b>{taskMap.get(taskRef)?.label || shortRef(taskRef, 36)}</b>
                      <small>{checkpointOutcome(outcomeMap.get(taskRef), selectedCheckpoint)?.summary || (zh ? "该任务结果被本次 Planner 决策消费" : "This task result was consumed by the Planner decision")}</small>
                    </span>
                  ))}
                </div>
              ) : (
                <p>{selectedCheckpoint.kind === "initial"
                  ? (zh ? "首次规划，没有前序 TaskOutcome；依据 Root Goal 与 Scope 创建入口任务。" : "Initial planning has no prior TaskOutcome; entry tasks are derived from the Root Goal and Scope.")
                  : (zh ? "没有新增 TaskOutcome 输入；Planner 基于当前任务图与运行状态完成本次检查。" : "No new TaskOutcome was consumed; Planner checked the current task graph and runtime state.")}</p>
              )}
            </section>

            <header className="planning-section-heading">
              <div>
                <ListChecks size={14} />
                <span>
                  <strong>{zh ? "任务状态" : "Task state"}</strong>
                  <small>{zh ? "本次决策涉及的任务及其最新结论" : "Tasks touched by this decision and their latest outcomes"}</small>
                </span>
              </div>
              <b>{taskRefs.length}</b>
            </header>
            <div className="planning-task-list">
              {taskRefs.length ? taskRefs.map((taskRef) => (
                <PlanningTaskRow
                  key={taskRef}
                  taskRef={taskRef}
                  label={taskMap.get(taskRef)?.label}
                  contextLabels={taskContextLabels(selectedCheckpoint, taskRef, zh)}
                  outcome={checkpointOutcome(outcomeMap.get(taskRef), selectedCheckpoint)}
                  epochs={props.epochOutcomes
                    .filter((item) => item.taskRef === taskRef && (selectedCheckpoint.endSeq === undefined || item.terminalSeq <= selectedCheckpoint.endSeq))
                    .sort((a, b) => a.terminalSeq - b.terminalSeq)}
                  zh={zh}
                />
              )) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? "该决策没有匹配当前筛选条件的任务" : "No tasks in this decision match the current filter"} />
              )}
            </div>
          </div>

          <aside className="planning-activity-pane">
            <header className="planning-section-heading">
              <div>
                <Activity size={14} />
                <span>
                  <strong>{zh ? "执行流" : "Execution stream"}</strong>
                  <small>{zh ? "决策提交后的 Agent 活动" : "Agent activity after this decision"}</small>
                </span>
              </div>
              <b>{checkpointItems.length}</b>
            </header>
            <div className="planning-activity-list">
              {checkpointItems.length ? [...checkpointItems].reverse().map((item, index, items) => (
                <button
                  type="button"
                  className={`planning-activity-item role-${roleToken(item.role)}${item.id === props.selectedTraceId ? " selected" : ""}`}
                  key={item.id}
                  onClick={() => props.onSelectTrace(item.id)}
                >
                  <span className="planning-activity-track">
                    <i />
                    {index < items.length - 1 ? <b /> : null}
                  </span>
                  <span className="planning-activity-copy">
                    <span><time>{formatTime(item.timestamp)}</time><em>{roleLabel(item.role)} · {item.stage}</em></span>
                    <strong>{localizeTracePresentation(item.title, locale)}</strong>
                    <small>{localizeTracePresentation(item.summary, locale) || item.eventLabel}</small>
                  </span>
                </button>
              )) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={zh ? "该筛选条件下无活动记录" : "No activity for this filter"} />
              )}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function DecisionMetric({ label, value }: { label: string; value: number }) {
  return <span><small>{label}</small><b>{String(value).padStart(2, "0")}</b></span>;
}

function checkpointTitle(checkpoint: PlannerCheckpoint, zh: boolean): string {
  if (checkpoint.kind === "initial") return zh ? "初始规划" : "Initial plan";
  if (checkpoint.kind === "terminal") return zh ? "最终决策" : "Final decision";
  return zh ? `决策 ${checkpoint.index}` : `Decision ${checkpoint.index}`;
}

function checkpointKindLabel(kind: PlannerCheckpoint["kind"], zh: boolean): string {
  if (kind === "initial") return zh ? "初始" : "initial";
  if (kind === "terminal") return zh ? "终态" : "terminal";
  return zh ? "更新" : "update";
}

function checkpointOutcome(outcome: TaskOutcome | undefined, checkpoint: PlannerCheckpoint): TaskOutcome | undefined {
  if (!outcome) return undefined;
  return checkpoint.endSeq === undefined || outcome.terminalSeq <= checkpoint.endSeq ? outcome : undefined;
}

function taskContextLabels(checkpoint: PlannerCheckpoint, taskRef: string, zh: boolean): string[] {
  return [
    checkpoint.inputTaskRefs.includes(taskRef) ? (zh ? "结果输入" : "outcome input") : undefined,
    checkpoint.createdTaskRefs.includes(taskRef) ? (zh ? "新建" : "created") : undefined,
    checkpoint.updatedTaskRefs.includes(taskRef) ? (zh ? "状态更新" : "updated") : undefined,
    checkpoint.executionTaskRefs.includes(taskRef) ? (zh ? "活跃任务" : "active task") : undefined
  ].filter((label): label is string => Boolean(label));
}

function PlanningTaskRow({
  taskRef,
  label,
  contextLabels,
  outcome,
  epochs,
  zh
}: {
  taskRef: string;
  label?: string;
  contextLabels: string[];
  outcome?: TaskOutcome;
  epochs: EpochOutcome[];
  zh: boolean;
}) {
  const [expanded, setExpanded] = useState(!outcome);
  const hasDetails = Boolean(outcome || epochs.length);
  const completed = outcome?.status === "completed";
  return (
    <article className={`planning-task-row${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="planning-task-summary"
        disabled={!hasDetails}
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={`planning-task-status${completed ? " completed" : outcome ? " ended" : " running"}`}>
          {completed ? <Check size={14} /> : outcome ? <span>!</span> : <LoaderCircle size={14} />}
        </span>
        <span className="planning-task-copy">
          <span>
            <strong>{label || shortRef(taskRef, 48)}</strong>
            {contextLabels.map((context) => <Tag className="planning-context-tag" key={context}>{context}</Tag>)}
            <Tag color={completed ? "success" : outcome?.status === "partial" ? "processing" : outcome ? "warning" : "default"}>
              {outcome?.status || (zh ? "执行中" : "in progress")}
            </Tag>
          </span>
          <small>{outcome?.summary || (zh ? "等待 TaskOutcome" : "Waiting for TaskOutcome")}</small>
        </span>
        {hasDetails ? <ChevronDown className="planning-task-chevron" size={14} /> : null}
      </button>
      {expanded && hasDetails ? (
        <div className="planning-task-details">
          <section>
            <span>{outcome ? "TaskOutcome" : (zh ? "当前状态" : "Current status")}</span>
            <p>{outcome?.summary || (zh ? "任务仍在执行，终态结论尚未提交。" : "The task is still running; no terminal outcome has been submitted.")}</p>
          </section>
          {epochs.length ? (
            <section className="planning-attempts">
              <span>{zh ? "执行尝试" : "Execution attempts"}</span>
              <div>
                {epochs.map((epoch, index) => (
                  <div key={epoch.epochRef}>
                    <b>{zh ? `第 ${index + 1} 次` : `Attempt ${index + 1}`}</b>
                    <em>{epoch.status}</em>
                    <small>{epoch.reason}</small>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function TraceCard({ item, selected, onSelect }: { item: TraceItem; selected: boolean; onSelect: () => void }) {
  const { locale, t } = useLanguage();
  const display = (value?: string) => localizeTracePresentation(value, locale);
  const details = [
    [t("trace.decision"), item.decision],
    [t("trace.observation"), item.tool ? undefined : item.observation],
    [t("trace.next"), display(item.next)],
    [t("trace.eventChain"), item.detail]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <article
      className={`trace-card role-${roleToken(item.role)}${selected ? " selected" : ""}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }}
    >
      <div className="trace-card-head">
        <div>
          <div className="trace-role-line"><i />{roleLabel(item.role)} · {display(item.eventLabel) || item.eventType}</div>
          <Typography.Title level={4}>{display(item.title)}</Typography.Title>
        </div>
        <Tag>{display(item.stage)}</Tag>
      </div>
      <div className="trace-preview">
        <div className="trace-preview-block thought">
          <span><BrainCircuit size={15} />{t(item.intentSource === "recorded" ? "trace.recordedIntent" : item.intentSource === "structured" ? "trace.structuredIntent" : "trace.derivedIntent")}</span>
          <p>{item.intentSource === "derived" ? display(item.summary) : item.summary || t("trace.noSummary")}</p>
        </div>
        <div className="trace-preview-block action">
          <span><PlayCircle size={15} />{t("trace.action")}</span>
          <p>{display(item.action) || t("trace.noAction")}</p>
        </div>
      </div>
      <div className="trace-card-foot">
        <div className="trace-refs">
          {item.taskId ? <Tag>{shortRef(item.taskId)}</Tag> : null}
          {item.evidenceRefs.length ? <Tag color="blue">Evidence {item.evidenceRefs.length}</Tag> : null}
          {item.artifactRefs.length ? <Tag color="cyan">Artifact {item.artifactRefs.length}</Tag> : null}
        </div>
        <time>{formatTime(item.timestamp)} · {formatRelative(item.timestamp)}</time>
      </div>
      <div onClick={(event) => event.stopPropagation()}>
        <Collapse
          className="trace-expand"
          size="small"
          items={[{
            key: "details",
            label: t("trace.expandDetails"),
            children: (
              <div className="trace-expanded-content">
                {details.length ? (
                  <div className="trace-detail-grid">
                    {details.map(([label, value]) => <div key={label}><span>{label}</span><p>{value}</p></div>)}
                  </div>
                ) : null}
                {item.tool ? <ToolRun item={item} /> : null}
                <Collapse
                  ghost
                  size="small"
                  items={[{
                    key: "raw",
                    label: t(item.eventType === "agent_action" || item.eventType === "tool_execution" ? "trace.aggregatedEvent" : "trace.rawEvent"),
                    children: <pre className="json-block">{JSON.stringify(item.rawEvent, null, 2)}</pre>
                  }]}
                />
              </div>
            )
          }]}
        />
      </div>
    </article>
  );
}

function ToolRun({ item }: { item: TraceItem }) {
  const { t } = useLanguage();
  const tool = item.tool!;
  return (
    <div className={`tool-run ${tool.isError ? "error" : tool.status === "running" ? "running" : "success"}`}>
      <div className="tool-run-title">
        <TerminalSquare size={16} />
        <strong>{tool.toolName}</strong>
        <span>{tool.isError ? <XCircle size={15} /> : tool.status === "running" ? <Clock3 size={15} /> : <CheckCircle2 size={15} />}{tool.status}</span>
      </div>
      {tool.command ? <pre>{tool.command}</pre> : null}
      <div className="tool-lifecycle">
        {tool.lifecycle.map((step, index) => <Tag key={`${step.timestamp}:${index}`}>{step.eventType.replaceAll("_", " ")}</Tag>)}
      </div>
      {tool.isError ? <Alert type="error" showIcon message={tool.resultPreview || t("trace.toolFailed")} /> : (
        <pre className="tool-output">{tool.resultPreview || t("trace.noToolOutput")}</pre>
      )}
    </div>
  );
}

function localizeTracePresentation(value: string | undefined, locale: Locale): string | undefined {
  if (!value || locale === "zh-CN") return value;
  const exact: Record<string, string> = {
    "执行动作": "Execution action",
    "规划判断": "Planning decision",
    "监督判断": "Supervision decision",
    "证据投影": "Evidence projection",
    "证据归档": "Evidence archived",
    "任务结果": "Task result",
    "思考与行动": "Reasoning and action",
    "执行中": "Running",
    "动作失败": "Action failed",
    "Executor 读取任务资料": "Executor reads task material",
    "Executor 读取关联 Artifact": "Executor reads a related artifact",
    "Executor 执行验证": "Executor runs validation",
    "Executor 归档执行证据": "Executor archives execution evidence",
    "Executor 提交任务结果": "Executor submits the task result",
    "Executor 执行动作": "Executor executes an action",
    "Planner 请求用户输入": "Planner requests user input",
    "Planner 更新任务计划": "Planner updates the task plan",
    "Observer 提交监督判断": "Observer submits a supervision decision",
    "Observer 更新三图": "Observer updates the tri-graph",
    "工具仍在运行或等待最终事件。": "The tool is still running or awaiting its final event.",
    "规划决策已提交，等待 Controller 应用任务图变更。": "The planning decision was submitted; waiting for Controller to apply the task graph changes.",
    "监督判断已提交，等待 Controller 执行控制信号。": "The supervision decision was submitted; waiting for Controller to apply the control signal.",
    "图增量已提交，等待 Runtime 校验并合并。": "The graph delta was submitted; waiting for Runtime validation and merge.",
    "任务结果已提交，等待 Controller 与 Planner 更新任务状态。": "The task result was submitted; waiting for Controller and Planner to update task state.",
    "执行材料已归档，可供任务结果和后续步骤引用。": "Execution material was archived for task results and subsequent steps.",
    "工具调用已完成，等待 Executor 消化结果或推进任务。": "The tool call completed; waiting for Executor to process the result or advance the task.",
    "读取关联 Artifact，恢复此前执行产生的关键证据与上下文。": "Read the related artifact to restore evidence and context from earlier execution.",
    "执行受控 HTTP 验证，收集目标响应与直接证据。": "Run controlled HTTP validation and collect the target response and direct evidence.",
    "执行受控命令，验证当前任务目标并收集直接证据。": "Run a controlled command to validate the current objective and collect direct evidence.",
    "归档本轮关键证据与执行结果，供任务结论和后续步骤引用。": "Archive key evidence and results for the task conclusion and subsequent steps.",
    "汇总当前任务的验证结果、证据与后续建议，并提交任务状态。": "Summarize validation results, evidence, and recommendations, then submit task state.",
    "根据当前任务与图状态提交下一步规划决策。": "Submit the next planning decision based on current task and graph state.",
    "根据近期执行进展提交监督判断，决定 Executor 是否继续或收束。": "Submit a supervision decision based on recent progress to continue or conclude execution."
  };
  if (exact[value]) return exact[value];
  return value
    .replace(/^HTTP 验证 · /, "HTTP validation · ")
    .replace(/^执行验证命令(?: · )?/, "Validation command · ")
    .replace(/^读取资料 · /, "Read material · ")
    .replace(/^读取 Artifact · /, "Read artifact · ")
    .replace(/^归档 Artifact · /, "Archive artifact · ")
    .replace(/^提交任务结果 · /, "Submit task result · ")
    .replace(/^提交监督信号 · /, "Submit supervision signal · ")
    .replace(/^提交图增量 · (\d+) 节点 \/ (\d+) 关系$/, "Submit graph delta · $1 nodes / $2 relationships")
    .replace(/^对 (.+) 执行受控 HTTP 验证，收集响应与直接证据。$/, "Run controlled HTTP validation against $1 and collect the response and direct evidence.");
}

function roleToken(role: Role): string {
  return String(role || "runtime").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}
