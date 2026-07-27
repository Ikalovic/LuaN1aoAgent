export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue | undefined>;

export type Role = "planner" | "executor" | "observer" | "runtime" | string;
export type GraphKind = "reasoning" | "operation" | "task";
export type ViewKey = "trace" | GraphKind | "traffic" | "connections";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "analyst";
  createdAt: string;
}

export interface AuthResponse {
  user: AuthUser;
}

export interface GraphNode {
  id: string;
  graphKind: string;
  type: string;
  label: string;
  properties: JsonRecord;
  evidenceRefs: string[];
  updatedAt?: string;
}

export interface GraphEdge {
  id?: string;
  from: string;
  to: string;
  type: string;
  properties: JsonRecord;
  evidenceRefs: string[];
  updatedAt?: string;
}

export interface ToolTrace {
  toolCallId: string;
  toolName: string;
  command?: string;
  status: string;
  isError: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  updateCount: number;
  eventCount: number;
  result: string;
  resultPreview: string;
  lifecycle: Array<{ eventType: string; timestamp: string; summary?: string }>;
}

export interface TraceItem {
  id: string;
  eventId: string;
  timestamp: string;
  taskId?: string;
  role: Role;
  eventType: string;
  eventLabel: string;
  stage: string;
  title: string;
  summary: string;
  intentSource: "recorded" | "structured" | "derived";
  detail: string;
  decision?: string;
  action?: string;
  observation?: string;
  next?: string;
  commandDetails?: string[];
  evidenceRefs: string[];
  artifactRefs: string[];
  graphNodeRefs: string[];
  tool?: ToolTrace;
  rawEvent: JsonRecord;
}

export interface ArtifactRecord {
  artifactRef: string;
  taskId?: string;
  kind?: string;
  mediaType?: string;
  path?: string;
  byteLength?: number;
  createdAt?: string;
  preview?: string;
}

export interface RuntimeSession {
  name: string;
  runtimeDir: string;
  relativePath?: string;
  isRoot: boolean;
  updatedAt?: string;
  source: string;
  nodeCount: number;
  edgeCount: number;
  taskCount: number;
  eventCount: number;
  artifactCount: number;
  goal?: string;
  latestTask?: string;
  latestTaskStatus?: string;
  running?: boolean;
}

export interface StartRunInput {
  goal: string;
  scope: string;
  maxRunTimeMs?: number;
  maxParallelTasks?: number;
  maxPlannerCycles?: number;
}

export interface StartRunResponse {
  runtimeDir: string;
  name: string;
  goal: string;
  scope: string;
  startedAt: string;
  running: boolean;
}

export interface ActiveRun {
  runtimeDir: string;
  name: string;
  goal: string;
  scope: string;
  startedAt: string;
  running: boolean;
}

export interface ActiveRunsResponse {
  loadedAt: string;
  runs: ActiveRun[];
}

export interface StopRunResponse {
  ok: boolean;
  runtimeDir: string;
  stopping: boolean;
}

export interface ArtifactContent {
  artifactRef: string;
  taskId?: string;
  kind?: string;
  mediaType?: string;
  byteLength?: number;
  truncated: boolean;
  encoding: "utf8" | "base64";
  content: string;
}

export interface RuntimeState {
  runtimeDir: string;
  loadedAt: string;
  overview: {
    goal?: { id: string; label: string; status?: JsonValue };
    scope?: { id: string; label: string; summary?: JsonValue };
    graph: { nodeCount: number; edgeCount: number; byKind: Record<string, number>; byType: Record<string, number> };
    events: { count: number; byRole: Record<string, number>; byType: Record<string, number> };
    tasks: {
      count: number;
      byStatus: Record<string, number>;
      latest?: TaskSummary;
      items: TaskSummary[];
    };
    artifacts: { count: number; totalBytes: number };
    agents: Record<string, AgentEvent | undefined>;
    latestControlSignal?: JsonRecord;
  };
  traceItems: TraceItem[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    source: string;
    summary: JsonRecord;
    sqliteError?: string;
  };
  events: JsonRecord[];
  artifacts: { records: ArtifactRecord[]; summary: { count: number; totalBytes: number } };
}

export interface TaskSummary {
  id: string;
  label: string;
  status: string;
  priority?: JsonValue;
  updatedAt?: string;
}

export interface AgentEvent {
  id?: string;
  role?: string;
  eventType?: string;
  timestamp?: string;
  summary?: string;
}

export interface SessionsResponse {
  rootDir: string;
  loadedAt: string;
  sessions: RuntimeSession[];
  summary: { count: number; totalTasks: number; totalEvents: number };
}

export interface TrafficHeaderEntry {
  name: string;
  value: string;
  ordinal: number;
}

export type TrafficFlowRef = string;

export interface TrafficExchange {
  id: TrafficFlowRef;
  kind?: "http" | "tcp";
  started_at: string;
  completed_at: string;
  duration_ms: number;
  method: string;
  url: string;
  host: string;
  scheme: string;
  protocol: string;
  mode: string;
  status: number;
  request_observed_bytes: number;
  response_observed_bytes: number;
  request_captured_bytes: number;
  response_captured_bytes: number;
  request_body_ref?: string;
  response_body_ref?: string;
  request_capture_state: string;
  response_capture_state: string;
  request_truncated: boolean;
  response_truncated: boolean;
  headers_truncated: boolean;
  quota_pressure: boolean;
  request_truncation_reason?: string;
  response_truncation_reason?: string;
  header_truncation_reason?: string;
  error?: string;
  runtime_ref?: string;
  task_ref?: string;
  run_ref?: string;
  attribution?: string;
  route_ref?: string;
  session_ref?: string;
  connection_ref?: string;
  epoch_ref?: string;
  connect_ref?: string;
  connect_authority?: string;
  connect_host?: string;
  connect_port?: string;
  replay_of?: TrafficFlowRef;
  error_code?: string;
  evicted_exchanges: number;
  request_headers?: TrafficHeaderEntry[];
  response_headers?: TrafficHeaderEntry[];
}

export interface TrafficHistoryPage {
  items: TrafficExchange[];
  has_more: boolean;
  next_cursor?: string;
}

export interface TrafficHistoryFilters {
  method?: string;
  host?: string;
  status?: number;
  task_ref?: string;
  run_ref?: string;
  mode?: string;
  error?: string;
}

export interface TrafficHistoryBody {
  exchange_id: TrafficFlowRef;
  side: "request" | "response";
  body_ref: string;
  encoding: "base64";
  data: string;
  bytes: number;
  truncated: boolean;
}

export interface TrafficReplayInput {
  runtimeDir: string;
  method?: string;
  url?: string;
  headers?: TrafficHeaderEntry[];
  body?: { encoding: "base64"; data: string };
  route_ref?: string;
  session_ref?: string;
  task_ref?: string;
  run_ref?: string;
}

export interface TrafficReplayResponse {
  exchangeId: TrafficFlowRef;
  replayOf: TrafficFlowRef;
  status: number;
  errorCode?: string;
}

export interface ConnectionItem {
  id: string;
  externalId: string;
  kind: "tunnel" | "route" | "connection";
  layer?: "definition" | "observation";
  direction: string;
  transport: string;
  managed: boolean;
  actions?: Array<"status" | "stop" | "reconnect" | "forget">;
  desiredState?: "running" | "stopped" | "closed";
  observedState: "live" | "degraded" | "stale" | "closed";
  lastHeartbeat?: string;
  error?: string;
  available: boolean;
  graphUrl?: string;
  routeRef?: string;
  connectionRef?: string;
  sessionRef?: string;
  taskRef?: string;
  runRef?: string;
  epochRef?: string;
}

export interface ConnectionsResponse {
  runtimeDir: string;
  loadedAt: string;
  runtimeControl: {
    active: boolean;
    mode: "controller" | "read_only";
    error?: string;
  };
  connections: ConnectionItem[];
}
