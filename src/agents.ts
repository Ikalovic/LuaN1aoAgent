import {
  createAgentSession,
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type CreateAgentSessionResult
} from "@earendil-works/pi-coding-agent";
import {
  EXECUTOR_SYSTEM_PROMPT,
  OBSERVER_PROJECTOR_SYSTEM_PROMPT,
  OBSERVER_SUPERVISOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT
} from "./prompts.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { ExecutionLog } from "./stores/execution-log.js";
import { SQLiteGraphStore } from "./stores/graph-store.js";
import type { LlmRuntime } from "./llm-config.js";
import { normalizePlannerDecision, validatePlannerBasedOnRefs } from "./planner-commands.js";
import type {
  ProjectionDraftValidationOptions,
  ProjectorGraphRefRegistry
} from "./projection.js";
import { createExecutorSandbox, type ExecutorSandbox } from "./executor-sandbox.js";
import type { ObserverMode, PlannerDecision } from "./types.js";
import {
  createArtifactReadTool,
  createArtifactWriteTool,
  createControlSubmitTool,
  createEvidenceListTool,
  createEvidenceReadTool,
  createGraphDeltaSubmitTool,
  createGraphQueryTool,
  createGraphSearchTool,
  createGraphTraceTool,
  createPlannerSubmitTool,
  createScopeDocumentSubmitTool,
  createScopeSubmitTool,
  createTaskResultSubmitTool,
  type GraphToolMaterialsResolver
} from "./tools/pi-tools.js";
import {
  createVulnerabilitySearchTool,
  createWebFetchTool,
  createWebSearchTool
} from "./tools/research-tools.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createProviderAdmissionExtension,
  type ProviderAdmissionOptions
} from "./pi-runner.js";
import { createBrowserRenderTool } from "./tools/browser-tools.js";

/** Project-local skills directory (./.agents/skills) installed by install.sh. */
export function projectSkillsDirs(cwd: string): string[] {
  const dir = join(cwd, ".agents", "skills");
  return existsSync(dir) ? [dir] : [];
}

export function agentCompactionSettings(contextWindow: number | undefined): {
  reserveTokens: number;
  keepRecentTokens: number;
} {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return {
      reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
    };
  }
  const window = Math.floor(contextWindow);
  const reserveTokens = Math.min(window - 1, Math.max(32_768, Math.floor(window / 4)));
  return {
    reserveTokens,
    keepRecentTokens: Math.min(20_000, Math.max(1, window - reserveTokens))
  };
}

function createRuntimeSettingsManager(contextWindow: number): SettingsManager {
  return SettingsManager.inMemory({ compaction: agentCompactionSettings(contextWindow) });
}

export type SecurityAgentRuntime = {
  planner: CreateAgentSessionResult["session"];
  executor: CreateAgentSessionResult["session"];
  observer: CreateAgentSessionResult["session"];
};

export type SecurityAgentSession = CreateAgentSessionResult["session"];

export function createExecutorResearchTools() {
  return [
    createWebFetchTool(),
    createWebSearchTool(),
    createVulnerabilitySearchTool()
  ];
}

export async function createSecurityAgentRuntime(input: {
  cwd: string;
  runtimeDir?: string;
  executorSandbox?: ExecutorSandbox;
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  providerAdmissions?: {
    planner?: ProviderAdmissionOptions;
    executor?: ProviderAdmissionOptions;
    supervisor?: ProviderAdmissionOptions;
  };
}): Promise<SecurityAgentRuntime> {
  const skillsDirs = projectSkillsDirs(input.cwd);
  const executorSandbox = input.executorSandbox ?? await createExecutorSandbox({
    runtimeDir: input.runtimeDir ?? `${input.cwd}/.agent-runtime`,
    runId: `standalone-${process.pid}`,
    additionalReadRoots: skillsDirs
  });
  const planner = await createPlannerAgentSession({
    cwd: input.cwd,
    graphStore: input.graphStore,
    artifactStore: input.artifactStore,
    llmRuntime: input.llmRuntime,
    executionLog: input.executionLog,
    providerAdmission: input.providerAdmissions?.planner
  });

  const executor = await createExecutorAgentSession({
    cwd: executorSandbox.root,
    sandbox: executorSandbox,
    artifactStore: input.artifactStore,
    llmRuntime: input.llmRuntime,
    skillsDirs,
    additionalTools: [
      createEvidenceListTool(input.executionLog),
      createEvidenceReadTool(input.executionLog)
    ],
    providerAdmission: input.providerAdmissions?.executor
  });

  const observer = await createObserverAgentSession({
    cwd: input.cwd,
    graphStore: input.graphStore,
    executionLog: input.executionLog,
    artifactStore: input.artifactStore,
    llmRuntime: input.llmRuntime,
    mode: "supervise",
    providerAdmission: input.providerAdmissions?.supervisor
  });

  return {
    planner: planner.session,
    executor: executor.session,
    observer: observer.session
  };
}

export async function createExecutorAgentSession(input: {
  cwd: string;
  sandbox?: ExecutorSandbox;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  executorLoader?: DefaultResourceLoader;
  sessionManager?: SessionManager;
  skillsDirs?: string[];
  additionalTools?: ToolDefinition<any, any, any>[];
  providerAdmission?: ProviderAdmissionOptions;
}): Promise<CreateAgentSessionResult> {
  const sandbox = input.sandbox ?? await createExecutorSandbox({
    runtimeDir: `${input.cwd}/.agent-runtime`,
    runId: `standalone-${process.pid}`,
    additionalReadRoots: input.skillsDirs ?? []
  });
  const executorLoader = input.executorLoader ?? await createPromptLoader(
    sandbox.hostRoot,
    EXECUTOR_SYSTEM_PROMPT,
    input.skillsDirs ?? [],
    input.providerAdmission
  );
  rejectUnmanagedProviderAdmission(input.executorLoader, input.providerAdmission);
  const customTools: ToolDefinition<any, any, any>[] = [
    ...createExecutorResearchTools(),
    createBrowserRenderTool({ runtime: sandbox.browserRuntime, allowHostFallback: false }),
    createArtifactReadTool(input.artifactStore, {
      workspace: sandbox.workspaceDir
        ? {
            hostDir: sandbox.workspaceDir,
            visibleRoot: sandbox.root,
            sharedWithContainer: sandbox.mode === "docker"
          }
        : undefined
    }),
    createArtifactWriteTool(input.artifactStore, {
      workspace: sandbox.workspaceDir
        ? { hostDir: sandbox.workspaceDir, visibleRoot: sandbox.root }
        : undefined,
      readExecutorFile: (visiblePath) => sandbox.readExecutorFile(visiblePath)
    }),
    ...(input.additionalTools ?? []),
    createTaskResultSubmitTool()
  ];
  return createAgentSession({
    cwd: sandbox.root,
    noTools: "builtin",
    customTools: [...sandbox.createTools(), ...customTools] as ToolDefinition<any, any, any>[],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.executor,
    thinkingLevel: input.llmRuntime.roleConfig.executor.thinkingLevel,
    resourceLoader: executorLoader,
    settingsManager: createRuntimeSettingsManager(input.llmRuntime.roleConfig.executor.contextWindow),
    sessionManager: input.sessionManager ?? SessionManager.inMemory(sandbox.root)
  });
}

export async function createPlannerAgentSession(input: {
  cwd: string;
  graphStore: SQLiteGraphStore;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  executionLog?: ExecutionLog;
  plannerLoader?: DefaultResourceLoader;
  providerAdmission?: ProviderAdmissionOptions;
  validatePlannerCommands?: (decision: PlannerDecision) => void | Promise<void>;
  plannerReferenceCandidates?: (prefix: string) => string[] | Promise<string[]>;
}): Promise<CreateAgentSessionResult> {
  const plannerLoader = input.plannerLoader ?? await createPromptLoader(
    input.cwd,
    PLANNER_SYSTEM_PROMPT,
    [],
    input.providerAdmission
  );
  rejectUnmanagedProviderAdmission(input.plannerLoader, input.providerAdmission);
  const graphMaterials = graphToolMaterialsResolver(input.executionLog);
  const plannerRetrievalPurpose = "Use only when a missing persisted fact would change Task status, topology, dependencies, priority, or budget; not for target-side technical investigation.";
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [
      createGraphQueryTool(input.graphStore, undefined, undefined, graphMaterials, plannerRetrievalPurpose),
      createGraphTraceTool(input.graphStore, undefined, undefined, graphMaterials, plannerRetrievalPurpose),
      ...(input.executionLog ? [
        createEvidenceListTool(input.executionLog, { description: plannerRetrievalPurpose }),
        createEvidenceReadTool(input.executionLog, { description: plannerRetrievalPurpose })
      ] : []),
      createArtifactReadTool(input.artifactStore, {
        maxReadBytes: 64_000,
        description: plannerRetrievalPurpose
      }),
      createValidatedPlannerSubmitTool(
        input.graphStore,
        input.artifactStore,
        input.executionLog,
        input.validatePlannerCommands,
        input.plannerReferenceCandidates
      )
    ],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: plannerLoader,
    settingsManager: createRuntimeSettingsManager(input.llmRuntime.roleConfig.planner.contextWindow),
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

export async function createScopeResolverAgentSession(input: {
  cwd: string;
  llmRuntime: LlmRuntime;
  providerAdmission?: ProviderAdmissionOptions;
}): Promise<CreateAgentSessionResult> {
  const loader = await createPromptLoader(
    input.cwd,
    `你是 Planner 的授权范围解析步骤。只从用户 Goal 原文中提取明确写出的 IPv4 地址或 CIDR。\n\n` +
    `规则：\n` +
    `- 裸 IPv4 输出为 /32；原文 CIDR 保持其前缀长度。\n` +
    `- 不解析域名，不做 DNS 查询，不根据“同一网络”“内网”等措辞扩大网段。\n` +
    `- 不输出原文没有明确出现的地址或更宽网段。\n` +
    `- 只调用 scope_submit 一次并结束。`,
    [],
    input.providerAdmission
  );
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [createScopeSubmitTool()],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: loader,
    settingsManager: createRuntimeSettingsManager(input.llmRuntime.roleConfig.planner.contextWindow),
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

export const SCOPE_DOCUMENT_RESOLVER_SYSTEM_PROMPT =
  `你是授权文件范围解析步骤。只选择输入片段中逐字出现的域名、IPv4 地址或 IPv4 CIDR。\n\n` +
  `规则：\n` +
  `- 每个候选必须引用其准确片段索引。\n` +
  `- 不得执行 DNS，不得补全相关资产、旁站或子站。\n` +
  `- 不得扩大 CIDR，不得把描述性网络措辞转换为地址。\n` +
  `- 不输出端口、协议、URL 路径或 IPv6。\n` +
  `- 可以提交空候选数组；只调用 scope_document_submit 一次并结束。`;

export async function createScopeDocumentResolverAgentSession(input: {
  cwd: string;
  llmRuntime: LlmRuntime;
  providerAdmission?: ProviderAdmissionOptions;
}): Promise<CreateAgentSessionResult> {
  const loader = await createPromptLoader(
    input.cwd,
    SCOPE_DOCUMENT_RESOLVER_SYSTEM_PROMPT,
    [],
    input.providerAdmission
  );
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [createScopeDocumentSubmitTool()],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: loader,
    settingsManager: createRuntimeSettingsManager(input.llmRuntime.roleConfig.planner.contextWindow),
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

function createValidatedPlannerSubmitTool(
  graphStore: SQLiteGraphStore,
  artifactStore: ArtifactStore,
  executionLog?: ExecutionLog,
  validatePlannerCommands?: (decision: PlannerDecision) => void | Promise<void>,
  plannerReferenceCandidates?: (prefix: string) => string[] | Promise<string[]>
) {
  return createPlannerSubmitTool({
    validate: async (value) => {
      const decision = normalizePlannerDecision(value);
      const resolved = await validatePlannerBasedOnRefs(decision, {
        listArtifacts: () => artifactStore.list(),
        referenceCandidates: async (prefix) => [...new Set([
          ...graphStore.nodeIdsWithPrefix(prefix),
          ...(executionLog?.eventIdsWithPrefix(prefix) ?? []),
          ...(await plannerReferenceCandidates?.(prefix) ?? [])
        ])]
      });
      if (validatePlannerCommands) {
        await validatePlannerCommands(resolved);
      }
      graphStore.validatePlannerDecision(resolved);
      return resolved;
    }
  });
}

export async function createObserverAgentSession(input: {
  cwd: string;
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  mode: ObserverMode;
  observerLoader?: DefaultResourceLoader;
  providerAdmission?: ProviderAdmissionOptions;
  projectorGraphRefs?: ProjectorGraphRefRegistry;
  projectorDraftValidation?: Omit<ProjectionDraftValidationOptions, "existingAliases">;
}): Promise<CreateAgentSessionResult> {
  const observerLoader = input.observerLoader ?? await createPromptLoader(
    input.cwd,
    input.mode === "supervise" ? OBSERVER_SUPERVISOR_SYSTEM_PROMPT : OBSERVER_PROJECTOR_SYSTEM_PROMPT,
    [],
    input.providerAdmission
  );
  rejectUnmanagedProviderAdmission(input.observerLoader, input.providerAdmission);
  const observerRole = input.mode === "supervise" ? "supervisor" : "projector";
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: observerToolsForMode(input),
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models[observerRole],
    thinkingLevel: input.llmRuntime.roleConfig[observerRole].thinkingLevel,
    resourceLoader: observerLoader,
    settingsManager: createRuntimeSettingsManager(input.llmRuntime.roleConfig[observerRole].contextWindow),
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

export function observerToolsForMode(input: {
  graphStore: SQLiteGraphStore;
  executionLog: ExecutionLog;
  artifactStore: ArtifactStore;
  mode: ObserverMode;
  projectorGraphRefs?: ProjectorGraphRefRegistry;
  projectorDraftValidation?: Omit<ProjectionDraftValidationOptions, "existingAliases">;
}) {
  if (input.mode === "supervise") {
    return [createControlSubmitTool()];
  }
  const graphReadCache = new Map<string, string>();
  const graphMaterials = graphToolMaterialsResolver(input.executionLog);
  return [
    createGraphSearchTool(input.graphStore, input.projectorGraphRefs, graphReadCache, graphMaterials),
    createGraphQueryTool(input.graphStore, input.projectorGraphRefs, graphReadCache, graphMaterials),
    createGraphTraceTool(input.graphStore, input.projectorGraphRefs, graphReadCache, graphMaterials),
    createGraphDeltaSubmitTool({
      existingAliases: input.projectorGraphRefs?.aliasContext(),
      ...input.projectorDraftValidation
    })
  ];
}

function graphToolMaterialsResolver(executionLog?: ExecutionLog): GraphToolMaterialsResolver | undefined {
  return executionLog
    ? (evidenceRefs) => executionLog.artifactRefsForEvents(evidenceRefs)
    : undefined;
}

async function createPromptLoader(
  cwd: string,
  systemPrompt: string,
  additionalSkillPaths: string[] = [],
  providerAdmission?: ProviderAdmissionOptions
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths,
    extensionFactories: providerAdmission
      ? [createProviderAdmissionExtension(providerAdmission)]
      : undefined,
    systemPromptOverride: () => systemPrompt
  });
  await loader.reload();
  return loader;
}

function rejectUnmanagedProviderAdmission(
  providedLoader: DefaultResourceLoader | undefined,
  providerAdmission: ProviderAdmissionOptions | undefined
): void {
  if (providedLoader && providerAdmission) {
    throw new Error("providerAdmission requires the session factory to create its DefaultResourceLoader");
  }
}
