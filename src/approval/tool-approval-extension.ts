import { createInterface } from "node:readline";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  classifyTool,
  type ApprovalMode
} from "./dangerous-tool-policy.js";
import { LlmRiskJudge, type ToolRiskAssessment } from "./llm-risk-judge.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, serializeToolArgs } from "./tool-approval-payload.js";
import {
  ToolApprovalRegistry,
  type ApprovalDecision,
  type ApprovalRequestContext
} from "./tool-approval-registry.js";

/**
 * Pi extension gating dangerous tool calls behind manual approval.
 *
 * Subscribes to the "tool_call" event (fires before tool execution, handler
 * may await) and routes each call through the policy:
 * - auto_allow        -> pass through immediately
 * - judge             -> LLM risk judge decides allow vs. human approval
 * - require_approval  -> always asks a human (WebUI operator or terminal)
 *
 * The handler awaits the decision, so the executor agent simply stays paused
 * until an operator answers. Denials return { block: true, reason } which the
 * agent sees as a tool error and can react to.
 */

export type TerminalApprover = (input: {
  toolName: string;
  toolArgs: string;
  intent?: string;
  riskLevel: "low" | "medium" | "high";
  reason?: string;
  taskGoal?: string;
  signal?: AbortSignal;
}) => Promise<ApprovalDecision>;

export type ToolApprovalExtensionOptions = {
  /** Static mode, or a getter read on every tool call so the WebUI can switch modes live. */
  mode: ApprovalMode | (() => ApprovalMode);
  context: ApprovalRequestContext;
  /** Judge instance, or a lazy getter so the judge session is only created when a mode actually needs it. */
  judge?: LlmRiskJudge | (() => Promise<LlmRiskJudge | undefined>);
  /** Web mode: the in-process approval queue owned by the web server. */
  registry?: ToolApprovalRegistry;
  /** Terminal mode: callback that asks the operator on the CLI. */
  terminalApprover?: TerminalApprover;
  signal?: AbortSignal | (() => AbortSignal);
};

export function createToolApprovalExtension(input: ToolApprovalExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, _ctx) => {
      const record = event as unknown as { toolName?: string; input?: unknown };
      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      if (!toolName) return;
      const signal = typeof input.signal === "function" ? input.signal() : input.signal;
      const cancelled = { block: true, reason: "任务已取消，审批不可用于执行" };
      if (signal?.aborted) return cancelled;
      const mode = typeof input.mode === "function" ? input.mode() : input.mode;
      const classification = classifyTool(toolName, mode);
      if (classification === "auto_allow") return;

      let argsText: string;
      try { argsText = serializeToolArgs(record.input); }
      catch { return { block: true, reason: "无法完整序列化工具参数，拒绝执行" }; }
      const toolArgs: unknown = JSON.parse(argsText);
      const context = { ...input.context };
      const contextText = JSON.stringify(context);
      const invalidated = () => {
        if (signal?.aborted) return cancelled;
        try {
          const currentMode = typeof input.mode === "function" ? input.mode() : input.mode;
          if (record.toolName === toolName && serializeToolArgs(record.input) === argsText
            && JSON.stringify(input.context) === contextText && currentMode === mode) return undefined;
        } catch { /* Changed or non-serializable input cannot reuse approval. */ }
        return { block: true, reason: "工具参数、上下文或审批模式已变化，请重新发起调用与审批" };
      };
      let assessment: ToolRiskAssessment | undefined;
      try {
        const judge = await untilAborted(
          Promise.resolve().then(() => typeof input.judge === "function" ? input.judge() : input.judge), signal
        );
        if (signal?.aborted) return cancelled;
        if (judge) {
          assessment = await untilAborted(judge.assess({
            toolName,
            toolArgs: JSON.parse(argsText),
            taskGoal: context.taskGoal,
            scopeSummary: context.scopeSummary,
            ...(classification === "require_approval" ? { forcedVerdict: "require_approval" as const } : {})
          }), signal);
        }
      } catch {
        assessment = undefined;
      }
      const changed = invalidated();
      if (changed) return changed;
      if (classification === "judge" && assessment?.verdict === "allow") return;

      let decision: ApprovalDecision = "deny";
      try {
        decision = await requestDecision({ ...input, context, signal }, { toolName, toolArgs, assessment });
      } catch { /* Approval interface failure denies execution. */ }
      if (decision === "approve") return invalidated();
      const intentText = assessment?.intent ? `（意图：${assessment.intent}）` : "";
      const reason = assessment?.reason || "操作存在潜在风险";
      return { block: true, reason: `危险操作 ${toolName}${intentText || " "}未被批准：${reason}` };
    });
  };
}

async function requestDecision(
  input: ToolApprovalExtensionOptions,
  toolCall: {
    toolName: string;
    toolArgs: unknown;
    assessment?: ToolRiskAssessment;
  }
): Promise<ApprovalDecision> {
  if (input.registry) {
    return input.registry.submit({
      context: input.context,
      toolName: toolCall.toolName,
      toolArgs: toolCall.toolArgs,
      intent: toolCall.assessment?.intent,
      riskLevel: toolCall.assessment?.riskLevel ?? "medium",
      reason: toolCall.assessment?.reason,
      signal: typeof input.signal === "function" ? input.signal() : input.signal
    });
  }
  if (input.terminalApprover) {
    const parentSignal = typeof input.signal === "function" ? input.signal() : input.signal;
    const expiresAt = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(DEFAULT_APPROVAL_TIMEOUT_MS);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    const decision = await untilAborted(input.terminalApprover({
      toolName: toolCall.toolName,
      toolArgs: JSON.stringify(JSON.parse(serializeToolArgs(toolCall.toolArgs)), null, 2),
      intent: toolCall.assessment?.intent,
      riskLevel: toolCall.assessment?.riskLevel ?? "medium",
      reason: toolCall.assessment?.reason,
      taskGoal: input.context.taskGoal,
      signal
    }), signal);
    return signal.aborted || Date.now() >= expiresAt ? "deny" : decision;
  }
  // No decision interface configured (e.g. web run without a registry).
  // Deny by default: a dangerous operation must never run unapproved.
  return "deny";
}

/**
 * Default terminal approver: asks on stdin with a y/N prompt, matching the
 * existing --confirm-scope-files interaction style.
 */
export function createStdinApprover(): TerminalApprover {
  return (input) => new Promise<ApprovalDecision>((resolve) => {
    if (input.signal?.aborted) { resolve("deny"); return; }
    // A non-interactive stdin can never answer this prompt. Failing closed keeps
    // the run moving instead of deadlocking the Executor forever on a question
    // nobody can answer — which is exactly what happens to a credential-attack
    // Agent, because running a brute-force command is routinely classified as
    // requiring approval, and a headless run then simply stops mid-task.
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `[approval] ${input.toolName} requires approval but stdin is not interactive; denying. `
        + `Re-run with a TTY to approve interactively, or set APPROVAL_MODE=off to pre-authorize `
        + `dangerous tools for this run.\n`
      );
      resolve("deny");
      return;
    }
    const lines = [
      "",
      "=== 危险操作待批准 ===",
      `工具: ${input.toolName}`,
      input.taskGoal ? `任务目标: ${input.taskGoal}` : "",
      input.intent ? `意图: ${input.intent}` : "",
      `风险等级: ${input.riskLevel}`,
      input.reason ? `判定理由: ${input.reason}` : "",
      `参数: ${input.toolArgs}`,
      ""
    ].filter((line) => line.length > 0);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let finished = false;
    const finish = (decision: ApprovalDecision): void => {
      if (finished) return;
      finished = true;
      input.signal?.removeEventListener("abort", cancel);
      prompt.close();
      resolve(decision);
    };
    const cancel = () => finish("deny");
    input.signal?.addEventListener("abort", cancel, { once: true });
    prompt.once("close", cancel);
    if (input.signal?.aborted) { cancel(); return; }
    prompt.question(`${lines.join("\n")}\n批准执行？[y/N] `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      finish(normalized === "y" || normalized === "yes" ? "approve" : "deny");
    });
  });
}

function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Approval cancelled"));
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { cleanup(); abort(); }
    work.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
