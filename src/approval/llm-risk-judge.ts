import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { invokeStructured } from "../pi-runner.js";

/**
 * LLM risk judge for dangerous tool calls.
 *
 * In auto mode the judge decides whether a tool call is safe to run or must
 * wait for human approval (attack-surface expansion, new techniques,
 * large-scale attempts, scope violations). In strict mode the judge only
 * produces the intent summary shown on the approval card.
 *
 * Judging is serialized per judge instance: executor tasks run in parallel,
 * but a single lightweight judge session answers one assessment at a time.
 */

export const APPROVAL_JUDGE_TOOL_NAME = "approval_judge_submit";

export const APPROVAL_JUDGE_SYSTEM_PROMPT = [
  "你是渗透测试 Agent 的危险操作风险裁判。",
  "输入包括任务目标、授权范围、工具名和调用参数。",
  "判定标准：",
  "- 是否扩大攻击面（新目标、新端口、新域名、新资产）；",
  "- 是否引入新的攻击手段或破坏性操作；",
  "- 是否大规模尝试（批量扫描、爆破、重放、批量写入）；",
  "- 是否可能超出授权范围（越界、访问范围外目标）。",
  "明显属于授权范围内常规侦察、读取或单点验证的操作判为 allow；",
  "存在任一风险信号的操作判为 require_approval。",
  "intent 用中文一句话说明该调用想要做什么（不含推理过程）；",
  "reason 用中文说明判定理由；riskLevel 给出 low/medium/high。",
  "只调用 approval_judge_submit 一次并结束。"
].join("\n");

export type ToolRiskAssessment = {
  verdict: "allow" | "require_approval";
  /** One-sentence Chinese intent summary shown on the approval card. */
  intent: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
};

export class LlmJudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmJudgeUnavailableError";
  }
}

type SubscribableSession = {
  prompt(text: string, options?: unknown): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort?: () => Promise<void>;
  clearQueue?: () => unknown;
};

/** Injectable structured-invoke shape, defaults to `invokeStructured` from pi-runner. */
export type RiskJudgeInvoker = (
  session: SubscribableSession,
  prompt: string,
  input: {
    toolName: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxTruncationSteers?: number;
    terminateOnToolError?: boolean;
    validate?: (value: unknown) => unknown;
  }
) => Promise<unknown>;

export function createApprovalJudgeSubmitTool() {
  return defineTool({
    name: APPROVAL_JUDGE_TOOL_NAME,
    label: "Submit Risk Assessment",
    description: "Submit the risk verdict, intent summary, risk level and reason for one tool call.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("allow"), Type.Literal("require_approval")]),
      intent: Type.String({ minLength: 1, maxLength: 500 }),
      riskLevel: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      reason: Type.String({ minLength: 1, maxLength: 2_000 })
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Risk assessment submitted" }],
      details: params,
      terminate: true
    })
  });
}

function normalizeAssessment(value: unknown): ToolRiskAssessment {
  if (!value || typeof value !== "object") {
    throw new Error("approval_judge_submit returned no details");
  }
  const record = value as Record<string, unknown>;
  const verdict = record.verdict === "allow" || record.verdict === "require_approval"
    ? record.verdict
    : undefined;
  if (!verdict) throw new Error("approval_judge_submit verdict must be allow or require_approval");
  const intent = typeof record.intent === "string" ? record.intent.trim() : "";
  if (!intent) throw new Error("approval_judge_submit intent must be a non-empty string");
  const riskLevel = record.riskLevel === "low" || record.riskLevel === "medium" || record.riskLevel === "high"
    ? record.riskLevel
    : "medium";
  const reason = typeof record.reason === "string" && record.reason.trim()
    ? record.reason.trim()
    : verdict === "require_approval" ? "存在潜在风险，需人工确认" : "";
  return { verdict, intent, riskLevel, reason };
}

export class LlmRiskJudge {
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly session: SubscribableSession,
    private readonly invoke: RiskJudgeInvoker = invokeStructured as RiskJudgeInvoker
  ) {}

  /** Abort the underlying judge session (controller shutdown). */
  dispose(): void {
    this.disposed = true;
    void this.session.abort?.();
  }

  assess(input: {
    toolName: string;
    toolArgs: unknown;
    taskGoal?: string;
    scopeSummary?: string;
    /** Strict mode: verdict is forced, only the intent summary is generated. */
    forcedVerdict?: "require_approval";
  }): Promise<ToolRiskAssessment> {
    const run = this.chain.then(() => this.assessNow(input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async assessNow(input: {
    toolName: string;
    toolArgs: unknown;
    taskGoal?: string;
    scopeSummary?: string;
    forcedVerdict?: "require_approval";
  }): Promise<ToolRiskAssessment> {
    if (this.disposed) {
      throw new LlmJudgeUnavailableError("Judge session is closed");
    }
    const argsText = summarizeArgs(input.toolArgs);
    const verdictLine = input.forcedVerdict
      ? "verdict 必须为 require_approval；只负责生成 intent/riskLevel/reason。"
      : "verdict 由你按上述标准判定。";
    const prompt = [
      "请评估以下工具调用的风险：",
      "",
      `任务目标：${input.taskGoal?.trim() || "(未提供)"}`,
      `授权范围：${input.scopeSummary?.trim() || "(未提供)"}`,
      `工具名称：${input.toolName}`,
      "调用参数：",
      "```json",
      argsText,
      "```",
      "",
      verdictLine
    ].join("\n");
    try {
      const raw = await this.invoke(this.session, prompt, {
        toolName: APPROVAL_JUDGE_TOOL_NAME,
        timeoutMs: 90_000,
        idleTimeoutMs: 60_000,
        maxTruncationSteers: 1,
        terminateOnToolError: true,
        validate: normalizeAssessment
      });
      const assessment = normalizeAssessment(raw);
      if (input.forcedVerdict) {
        return { ...assessment, verdict: "require_approval" };
      }
      return assessment;
    } catch (error) {
      throw new LlmJudgeUnavailableError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  try {
    const text = JSON.stringify(args) ?? String(args);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}... (truncated)` : text;
  } catch {
    return String(args);
  }
}
