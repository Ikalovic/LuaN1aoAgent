import type { ViewKey } from "./types";
export interface NavigationState {
  runtimeDir: string;
  view: ViewKey;
  nodeId?: string; traceId?: string; taskId?: string; exchangeId?: string;
  range?: string; from?: string; to?: string;
  nodeType?: string; findingType?: string; taskStatus?: string; role?: string;
  wallGraph?: string; wallSize?: string;
}
export const VIEWS = ["overview", "operation", "trace", "task", "findings", "reasoning", "traffic", "connections", "reports", "skills", "mcp", "env", "credentials", "approvals", "wallboard"] as const;
const entities = ["nodeId", "traceId", "taskId", "exchangeId"] as const;
const enums = {
  wallGraph: ["operation", "reasoning", "task"],
  wallSize: ["standard", "distance"],
  range: ["loaded", "15m", "1h", "24h", "custom"],
  role: ["all", "planner", "executor", "observer", "runtime"],
  findingType: ["all", "Vulnerability", "Exploit", "Hypothesis"],
  nodeType: ["Host", "Port", "Service", "WebEndpoint", "WebEntry", "Parameter", "Credential", "Session", "AgentSession", "ShellSession", "Evidence", "Vulnerability", "Exploit", "Hypothesis", "Task", "Scope", "Goal"],
  taskStatus: ["open", "completed", "blocked", "failed", "archived", "unknown"]
};
export function parseNavigation(search: string, readStorage = () => localStorage.getItem("luanniao-runtime-dir")): NavigationState {
  const params = new URLSearchParams(search);
  let stored: string | null = null;
  try { stored = readStorage(); } catch { /* Browser storage is optional. */ }
  const candidate = params.get("view");
  const result: NavigationState = { runtimeDir: params.get("runtimeDir")?.trim() || stored || ".agent-runtime", view: VIEWS.includes(candidate as ViewKey) ? candidate as ViewKey : "overview" };
  for (const key of entities) if (params.get(key)) result[key] = params.get(key)!;
  for (const key of Object.keys(enums) as Array<keyof typeof enums>) {
    const value = params.get(key);
    if (value && enums[key].includes(value)) result[key] = value;
  }
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) result[key] = new Date(value).toISOString();
  }
  if (result.from && result.to && result.from > result.to) { delete result.from; delete result.to; }
  return result;
}
export function navigationUrl(state: NavigationState): string {
  const params = new URLSearchParams();
  for (const key of ["runtimeDir", "view", ...entities, ...Object.keys(enums), "from", "to"] as Array<keyof NavigationState>) if (state[key]) params.set(key, state[key]!);
  return `?${params}`;
}
export function transitionNavigation(state: NavigationState, patch: Partial<NavigationState>): NavigationState {
  const next = { ...state, ...patch };
  if (patch.runtimeDir !== undefined && patch.runtimeDir !== state.runtimeDir) {
    for (const key of [...entities, "nodeType", "findingType", "taskStatus", "role"] as const) delete next[key];
  }
  return parseNavigation(navigationUrl(next), () => null);
}
