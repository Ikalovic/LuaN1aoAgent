import { randomUUID } from "node:crypto";
import type { ExecutionLog } from "../stores/execution-log.js";

/**
 * In-process queue of tool approval requests.
 *
 * Approval requests stay pending until an operator decides (no timeout by
 * design: a hung approval is visible in the WebUI, and the run keeps waiting).
 * When a run finishes or fails, `settleRun` rejects everything still pending so
 * the executor agent gets a block reason instead of leaking promises.
 *
 * Every request and decision is appended to the execution log for audit.
 */

export type ApprovalRequestContext = {
  runId: string;
  runtimeDir: string;
  taskId?: string;
  taskGoal?: string;
  scopeSummary?: string;
};

export type ApprovalDecision = "approve" | "deny";

export type PendingApproval = {
  id: string;
  runId: string;
  runtimeDir: string;
  taskId?: string;
  taskGoal?: string;
  scopeSummary?: string;
  toolName: string;
  toolArgs: string;
  /** LLM-generated intent summary (strict mode, or auto mode when gated). */
  intent?: string;
  riskLevel: "low" | "medium" | "high";
  reason?: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "settled";
  decidedAt?: string;
};

type ApprovalRequest = {
  pending: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
};

export type ToolApprovalRegistryOptions = {
  /** Resolve the execution log for a runtime dir (audit trail); undefined disables audit. */
  executionLogProvider?: (runtimeDir: string) => ExecutionLog | undefined;
  now?: () => number;
};

export class ToolApprovalRegistry {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly executionLogProvider?: (runtimeDir: string) => ExecutionLog | undefined;
  private readonly now: () => number;

  constructor(input: ToolApprovalRegistryOptions = {}) {
    this.executionLogProvider = input.executionLogProvider;
    this.now = input.now ?? Date.now;
  }

  /** Submit a tool call for approval. Resolves only when an operator decides. */
  submit(input: {
    context: ApprovalRequestContext;
    toolName: string;
    toolArgs: unknown;
    intent?: string;
    riskLevel: "low" | "medium" | "high";
    reason?: string;
  }): Promise<ApprovalDecision> {
    const id = randomUUID();
    const pending: PendingApproval = {
      id,
      runId: input.context.runId,
      runtimeDir: input.context.runtimeDir,
      taskId: input.context.taskId,
      taskGoal: input.context.taskGoal,
      scopeSummary: input.context.scopeSummary,
      toolName: input.toolName,
      toolArgs: summarizeToolArgs(input.toolArgs),
      intent: input.intent,
      riskLevel: input.riskLevel,
      reason: input.reason,
      createdAt: new Date(this.now()).toISOString(),
      status: "pending"
    };
    const request: ApprovalRequest = {
      pending,
      resolve: () => undefined,
      reject: () => undefined
    };
    const decision = new Promise<ApprovalDecision>((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });
    this.requests.set(id, request);
    void this.appendAudit(pending.runtimeDir, pending.taskId, "tool_approval_requested", {
      approvalId: id,
      runId: pending.runId,
      runtimeDir: pending.runtimeDir,
      toolName: pending.toolName,
      riskLevel: pending.riskLevel,
      pending: true
    });
    return decision;
  }

  list(input: { runtimeDir?: string } = {}): PendingApproval[] {
    const pending: PendingApproval[] = [];
    for (const request of this.requests.values()) {
      if (request.pending.status !== "pending") continue;
      if (input.runtimeDir && request.pending.runtimeDir !== input.runtimeDir) continue;
      pending.push({ ...request.pending });
    }
    return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  decide(id: string, decision: ApprovalDecision): boolean {
    const request = this.requests.get(id);
    if (!request || request.pending.status !== "pending") return false;
    request.pending.status = decision === "approve" ? "approved" : "denied";
    request.pending.decidedAt = new Date(this.now()).toISOString();
    this.requests.delete(id);
    request.resolve(decision);
    void this.appendAudit(request.pending.runtimeDir, request.pending.taskId, "tool_approval_decided", {
      approvalId: id,
      runId: request.pending.runId,
      runtimeDir: request.pending.runtimeDir,
      toolName: request.pending.toolName,
      decision
    });
    return true;
  }

  /** Reject everything still pending for a run (run finished, failed, or stopped). */
  settleRun(runId: string): number {
    let settled = 0;
    for (const [id, request] of [...this.requests.entries()]) {
      if (request.pending.runId !== runId || request.pending.status !== "pending") continue;
      settled += 1;
      request.pending.status = "settled";
      request.pending.decidedAt = new Date(this.now()).toISOString();
      this.requests.delete(id);
      request.resolve("deny");
      void this.appendAudit(request.pending.runtimeDir, request.pending.taskId, "tool_approval_settled", {
        approvalId: id,
        runId: request.pending.runId,
        toolName: request.pending.toolName
      });
    }
    return settled;
  }

  get pendingCount(): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.pending.status === "pending") count += 1;
    }
    return count;
  }

  private async appendAudit(
    runtimeDir: string,
    taskId: string | undefined,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const executionLog = this.executionLogProvider?.(runtimeDir);
    if (!executionLog) return;
    await executionLog.append({
      taskId,
      role: "runtime",
      eventType,
      summary: typeof payload.summary === "string" ? payload.summary : eventType,
      payload
    }).catch(() => undefined);
  }
}

function summarizeToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  try {
    const text = JSON.stringify(args, null, 2) ?? String(args);
    return text.length > 8_000 ? `${text.slice(0, 8_000)}\n... (truncated)` : text;
  } catch {
    return String(args);
  }
}
