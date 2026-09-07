import { createInterface } from "node:readline";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  classifyTool,
  isDangerousTool,
  type ApprovalMode
} from "./dangerous-tool-policy.js";
import { LlmRiskJudge, LlmJudgeUnavailableError, type ToolRiskAssessment } from "./llm-risk-judge.js";
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
};

export function createToolApprovalExtension(input: ToolApprovalExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, _ctx) => {
      const record = event as unknown as { toolName?: string; input?: unknown };
      const toolName = typeof record.toolName === "string" ? record.toolName : "";
      if (!toolName) return;
      const mode = typeof input.mode === "function" ? input.mode() : input.mode;
      const classification = classifyTool(toolName, mode);
      if (classification === "auto_allow") return;

      const toolArgs = record.input;
      let assessment: ToolRiskAssessment | undefined;
      const judge = typeof input.judge === "function" ? await input.judge() : input.judge;

      if (classification === "judge") {
        if (judge) {
          try {
            assessment = await judge.assess({
              toolName,
              toolArgs,
              taskGoal: input.context.taskGoal,
              scopeSummary: input.context.scopeSummary
            });
          } catch (error) {
            if (!(error instanceof LlmJudgeUnavailableError)) throw error;
            // Judge unavailable: fall back to the conservative static list.
            // Unknown tools are allowed; known-dangerous tools require approval.
            if (!isDangerousTool(toolName)) return;
          }
        }
        if (assessment?.verdict === "allow") return;
      }

      if (classification === "require_approval" && judge) {
        try {
          assessment = await judge.assess({
            toolName,
            toolArgs,
            taskGoal: input.context.taskGoal,
            scopeSummary: input.context.scopeSummary,
            forcedVerdict: "require_approval"
          });
        } catch {
          assessment = undefined;
        }
      }

      const decision = await requestDecision(input, {
        toolName,
        toolArgs,
        assessment
      });
      if (decision === "approve") return;
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
      reason: toolCall.assessment?.reason
    });
  }
  if (input.terminalApprover) {
    return input.terminalApprover({
      toolName: toolCall.toolName,
      toolArgs: summarizeToolArgs(toolCall.toolArgs),
      intent: toolCall.assessment?.intent,
      riskLevel: toolCall.assessment?.riskLevel ?? "medium",
      reason: toolCall.assessment?.reason,
      taskGoal: input.context.taskGoal
    });
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
    const finish = (decision: ApprovalDecision): void => {
      prompt.close();
      resolve(decision);
    };
    prompt.question(`${lines.join("\n")}\n批准执行？[y/N] `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      finish(normalized === "y" || normalized === "yes" ? "approve" : "deny");
    });
  });
}

function summarizeToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  try {
    const text = JSON.stringify(args, null, 2) ?? String(args);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n... (truncated)` : text;
  } catch {
    return String(args);
  }
}
