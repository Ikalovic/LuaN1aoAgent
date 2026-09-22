import { createHash, randomUUID } from "node:crypto";
import type { ExecutionLog } from "../stores/execution-log.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, serializeToolArgs } from "./tool-approval-payload.js";

/**
 * In-process queue of tool approval requests.
 *
 * Approval requests expire and can be cancelled while audit writes are pending.
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
  expiresAt: string;
  payloadHash: string;
  status: "pending" | "approved" | "denied" | "settled";
  decidedAt?: string;
};

type ApprovalRequest = {
  pending: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  auditReady: Promise<boolean>;
  deciding: boolean;
  cleanup: () => void;
};

export type ToolApprovalRegistryOptions = {
  /** Omitting the provider disables audit; a configured provider must return a usable log. */
  executionLogProvider?: (runtimeDir: string) => ExecutionLog | undefined;
  now?: () => number;
  approvalTimeoutMs?: number;
};

export class ToolApprovalRegistry {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly executionLogProvider?: (runtimeDir: string) => ExecutionLog | undefined;
  private readonly now: () => number;
  private readonly approvalTimeoutMs: number;

  constructor(input: ToolApprovalRegistryOptions = {}) {
    this.executionLogProvider = input.executionLogProvider;
    this.now = input.now ?? Date.now;
    this.approvalTimeoutMs = input.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.approvalTimeoutMs) || this.approvalTimeoutMs <= 0
      || this.approvalTimeoutMs > 2_147_483_647) {
      throw new Error("approvalTimeoutMs must be a positive timer duration");
    }
  }

  /** Submit a tool call; expiration, cancellation or audit failure resolve to deny. */
  submit(input: {
    context: ApprovalRequestContext;
    toolName: string;
    toolArgs: unknown;
    intent?: string;
    riskLevel: "low" | "medium" | "high";
    reason?: string;
    signal?: AbortSignal;
  }): Promise<ApprovalDecision> {
    if (input.signal?.aborted) return Promise.resolve("deny");
    const id = randomUUID();
    const toolArgs = serializeToolArgs(input.toolArgs);
    const createdAt = this.now();
    const pending: PendingApproval = {
      id,
      runId: input.context.runId,
      runtimeDir: input.context.runtimeDir,
      taskId: input.context.taskId,
      taskGoal: input.context.taskGoal,
      scopeSummary: input.context.scopeSummary,
      toolName: input.toolName,
      toolArgs: JSON.stringify(JSON.parse(toolArgs), null, 2),
      intent: input.intent,
      riskLevel: input.riskLevel,
      reason: input.reason,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.approvalTimeoutMs).toISOString(),
      payloadHash: createHash("sha256").update(JSON.stringify({
        context: input.context, toolName: input.toolName, toolArgs
      })).digest("hex"),
      status: "pending"
    };
    const request: ApprovalRequest = {
      pending,
      resolve: () => undefined,
      auditReady: Promise.resolve(false),
      deciding: false,
      cleanup: () => undefined
    };
    const decision = new Promise<ApprovalDecision>((resolve) => {
      request.resolve = resolve;
    });
    this.requests.set(id, request);
    const cancel = () => { this.settle(request, "cancelled"); };
    const timer = setTimeout(() => this.settle(request, "expired"), this.approvalTimeoutMs);
    timer.unref();
    input.signal?.addEventListener("abort", cancel, { once: true });
    request.cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
    };
    request.auditReady = this.appendAudit(pending.runtimeDir, pending.taskId, "tool_approval_requested", {
      approvalId: id,
      runId: pending.runId,
      runtimeDir: pending.runtimeDir,
      toolName: pending.toolName,
      riskLevel: pending.riskLevel,
      payloadHash: pending.payloadHash,
      expiresAt: pending.expiresAt,
      pending: true
    }).then(() => true, () => {
      this.reportAuditFailure(pending.id);
      this.finish(request, "deny", "settled");
      return false;
    });
    return decision;
  }

  list(input: { runtimeDir?: string } = {}): PendingApproval[] {
    const pending: PendingApproval[] = [];
    for (const request of this.requests.values()) {
      if (this.expired(request)) { this.settle(request, "expired"); continue; }
      if (request.pending.status !== "pending") continue;
      if (input.runtimeDir && request.pending.runtimeDir !== input.runtimeDir) continue;
      pending.push({ ...request.pending });
    }
    return pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async decide(id: string, decision: ApprovalDecision): Promise<boolean> {
    const request = this.requests.get(id);
    if (decision !== "approve" && decision !== "deny") return false;
    if (!request || request.deciding) return false;
    request.deciding = true;
    if (this.expired(request)) { this.settle(request, "expired"); return false; }
    if (!await request.auditReady || !this.requests.has(id)) return false;
    try {
      // This records operator intent, not a guarantee that execution follows.
      await this.appendAudit(request.pending.runtimeDir, request.pending.taskId, "tool_approval_decided", {
        approvalId: id,
        runId: request.pending.runId,
        runtimeDir: request.pending.runtimeDir,
        toolName: request.pending.toolName,
        payloadHash: request.pending.payloadHash,
        decision
      });
    } catch {
      this.reportAuditFailure(id);
      this.finish(request, "deny", "settled");
      return false;
    }
    if (this.expired(request)) { this.settle(request, "expired"); return false; }
    return this.finish(request, decision, decision === "approve" ? "approved" : "denied");
  }

  /** Reject everything still pending for a run (run finished, failed, or stopped). */
  settleRun(runId: string): number {
    let settled = 0;
    for (const request of [...this.requests.values()]) {
      if (request.pending.runId !== runId || request.pending.status !== "pending") continue;
      settled += 1;
      this.settle(request, "run_settled");
    }
    return settled;
  }

  get pendingCount(): number {
    return this.list().length;
  }

  private expired(request: ApprovalRequest): boolean {
    return this.now() >= Date.parse(request.pending.expiresAt);
  }

  private finish(request: ApprovalRequest, decision: ApprovalDecision, status: PendingApproval["status"]): boolean {
    if (!this.requests.delete(request.pending.id)) return false;
    request.pending.status = status;
    request.pending.decidedAt = new Date(this.now()).toISOString();
    request.cleanup();
    request.resolve(decision);
    return true;
  }

  private settle(request: ApprovalRequest, reason: string): void {
    if (!this.finish(request, "deny", "settled")) return;
    // Stopping must not wait for storage to recover.
    void request.auditReady.then(async (ready) => {
      if (!ready) return;
      await this.appendAudit(request.pending.runtimeDir, request.pending.taskId, "tool_approval_settled", {
        approvalId: request.pending.id, runId: request.pending.runId,
        toolName: request.pending.toolName, payloadHash: request.pending.payloadHash, reason
      });
    }).catch(() => this.reportAuditFailure(request.pending.id));
  }

  private reportAuditFailure(id: string): void {
    process.stderr.write(`[approval] Audit persistence failed for ${id}; approval cannot authorize execution.\n`);
  }

  private async appendAudit(
    runtimeDir: string,
    taskId: string | undefined,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.executionLogProvider) return;
    const executionLog = this.executionLogProvider(runtimeDir);
    if (!executionLog) throw new Error("Approval execution log unavailable");
    await executionLog.append({
      taskId,
      role: "runtime",
      eventType,
      summary: typeof payload.summary === "string" ? payload.summary : eventType,
      payload
    });
  }
}
