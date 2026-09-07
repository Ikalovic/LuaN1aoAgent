/**
 * Tool approval policy for dangerous operations.
 *
 * Three modes, resolved from APPROVAL_MODE / --approval-mode:
 * - "off":    full control, no tool call is ever gated (agent runs autonomously)
 * - "auto":   read-only reconnaissance tools pass through; everything else is
 *             assessed by the LLM judge which requests human approval only when
 *             the call looks like it expands attack surface, introduces a new
 *             attack technique, attempts something at scale, or risks going
 *             out of scope.
 * - "strict": every tool call requires approval, with an LLM-generated intent
 *             summary shown on the approval card.
 */

export type ApprovalMode = "off" | "auto" | "strict";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["off", "auto", "strict"];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

export const APPROVAL_MODE_ENV = "APPROVAL_MODE";

/** How a tool call is routed by the policy (auto mode only; strict forces approval). */
export type PolicyClassification = "auto_allow" | "judge" | "require_approval";

/** Read-only reconnaissance: never gated in auto mode, no LLM call needed. */
const READONLY_TOOL_PATTERNS: readonly RegExp[] = [
  /^read$/,
  /^grep$/,
  /^ls$/,
  /^glob$/,
  /^graph_query$/,
  /^graph_search$/,
  /^graph_trace$/,
  /^evidence_list$/,
  /^evidence_read$/,
  /^artifact_read$/,
  /^web_search$/,
  /^vulnerability_search$/,
  /^route_status$/,
  /^task_result_submit$/
];

/**
 * Explicitly dangerous tools. Used as the conservative fallback when the LLM
 * judge is unavailable in auto mode: these then require approval instead of
 * being silently allowed.
 */
const DANGEROUS_TOOL_PATTERNS: readonly RegExp[] = [
  /^bash$/,
  /^write$/,
  /^edit$/,
  /^artifact_write$/,
  /^web_fetch$/,
  /^browser_render$/,
  /^route_open$/,
  /^route_stop$/,
  /^replay/,
  /^fofa_/,
  /^credential_/,
  /^topology_validate$/
];

export function resolveApprovalMode(raw: string | undefined): ApprovalMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "off") return "off";
  if (normalized === "strict") return "strict";
  if (normalized === "auto" || normalized === undefined || normalized === "") {
    return "auto";
  }
  throw new Error(
    `Invalid approval mode "${raw}": expected one of ${APPROVAL_MODES.join(", ")}`
  );
}

export function isReadonlyTool(toolName: string): boolean {
  return READONLY_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function isDangerousTool(toolName: string): boolean {
  return DANGEROUS_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

/**
 * Route a tool call through the policy.
 *
 * - off:    auto_allow
 * - strict: require_approval (every call)
 * - auto:   readonly whitelist -> auto_allow, everything else -> judge
 */
export function classifyTool(toolName: string, mode: ApprovalMode): PolicyClassification {
  if (mode === "off") return "auto_allow";
  if (mode === "strict") return "require_approval";
  return isReadonlyTool(toolName) ? "auto_allow" : "judge";
}
