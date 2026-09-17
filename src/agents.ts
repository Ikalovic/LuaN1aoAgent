import {
  createAgentSession,
  DEFAULT_COMPACTION_SETTINGS,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type CreateAgentSessionResult,
  type ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import {
  EXECUTOR_SYSTEM_PROMPT,
  OBSERVER_PROJECTOR_SYSTEM_PROMPT,
  OBSERVER_SUPERVISOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT
} from "./prompts.js";
import { renderSpecialistSystemPrompt } from "./specialists/prompt.js";
import { applySpecialistToolPolicy, validateSpecialistTools, type SpecialistToolSelection } from "./specialists/tools.js";
import type {
  SpecialistAgentDefinition,
  SpecialistOptionValues,
  SpecialistRegistryDiagnostic,
  SpecialistToolBinding,
  SpecialistToolGroup
} from "./specialists/types.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { ExecutionLog } from "./stores/execution-log.js";
import { SQLiteGraphStore } from "./stores/graph-store.js";
import type { LlmRuntime, LlmThinkingLevel } from "./llm-config.js";
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
  createSkillSelectionSubmitTool,
  createScopeSubmitTool,
  createTaskResultSubmitTool,
  type GraphToolMaterialsResolver
} from "./tools/pi-tools.js";
import {
  createVulnerabilitySearchTool,
  createWebFetchTool,
  createWebSearchTool
} from "./tools/research-tools.js";
import { createOsintSearchTool } from "./tools/osint-search-tools.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createProviderAdmissionExtension,
  type ProviderAdmissionOptions
} from "./pi-runner.js";
import { createBrowserRenderTool } from "./tools/browser-tools.js";
import {
  createToolApprovalExtension,
  type ToolApprovalExtensionOptions
} from "./approval/tool-approval-extension.js";
import {
  APPROVAL_JUDGE_SYSTEM_PROMPT,
  createApprovalJudgeSubmitTool
} from "./approval/llm-risk-judge.js";

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

/**
 * Strictly-passive OSINT collection. Kept in its own group so a Specialist can
 * take public-internet collection without also taking FOFA, credential stores
 * or the gateway diagnostics that other groups carry.
 */
export function createExecutorOsintTools() {
  return [createOsintSearchTool()];
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
    executionLog: input.executionLog,
    additionalToolBindings: [
      createEvidenceListTool(input.executionLog),
      createEvidenceReadTool(input.executionLog)
    ].map((tool) => ({ group: "evidence" as const, tool })),
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

/**
 * Runtime-facing Specialist payload for one Executor session. Tool assembly is
 * the only place the Executor's capability surface is decided, so a Specialist
 * can narrow it here and nowhere else.
 */
export type ExecutorSpecialistInput = {
  id: string;
  taskId: string;
  definition: SpecialistAgentDefinition;
  options: SpecialistOptionValues;
};

export async function createExecutorAgentSession(input: {
  cwd: string;
  sandbox?: ExecutorSandbox;
  artifactStore: ArtifactStore;
  llmRuntime: LlmRuntime;
  executionLog?: ExecutionLog;
  executorLoader?: DefaultResourceLoader;
  sessionManager?: SessionManager;
  skillsDirs?: string[];
  /** Task runtime tools tagged with their capability group. */
  additionalToolBindings?: SpecialistToolBinding[];
  specialist?: ExecutorSpecialistInput;
  /** Receives per-session Specialist diagnostics (tool policy, contributed tools). */
  onSpecialistDiagnostic?: (diagnostic: SpecialistRegistryDiagnostic) => void;
  providerAdmission?: ProviderAdmissionOptions;
  toolApproval?: ToolApprovalExtensionOptions;
}): Promise<CreateAgentSessionResult> {
  const sandbox = input.sandbox ?? await createExecutorSandbox({
    runtimeDir: `${input.cwd}/.agent-runtime`,
    runId: `standalone-${process.pid}`,
    additionalReadRoots: input.skillsDirs ?? []
  });
  const specialistDiagnostics: SpecialistRegistryDiagnostic[] = [];
  const specialistSelection = applySpecialistToolPolicy(
    executorToolBindings({ sandbox, artifactStore: input.artifactStore, additionalToolBindings: input.additionalToolBindings }),
    input.specialist?.definition.tools
  );
  specialistDiagnostics.push(...specialistSelection.diagnostics);
  const executorLoader = input.executorLoader ?? await createPromptLoader(
    sandbox.hostRoot,
    input.specialist
      ? renderSpecialistSystemPrompt({
        definition: input.specialist.definition,
        options: input.specialist.options,
        basePrompt: EXECUTOR_SYSTEM_PROMPT,
        enabledGroups: specialistSelection.enabledGroups,
        disabledGroups: specialistSelection.disabledGroups
      }).systemPrompt
      : EXECUTOR_SYSTEM_PROMPT,
    input.skillsDirs ?? [],
    input.providerAdmission,
    input.toolApproval ? [createToolApprovalExtension(input.toolApproval)] : undefined
  );
  rejectUnmanagedProviderAdmission(input.executorLoader, input.providerAdmission);
  const contributed = input.specialist?.definition.createTools
    ? contributeSpecialistTools({
      specialist: input.specialist,
      sandbox,
      artifactStore: input.artifactStore,
      executionLog: input.executionLog,
      selection: specialistSelection
    })
    : { tools: [], diagnostics: [] };
  specialistDiagnostics.push(...contributed.diagnostics);
  for (const diagnostic of specialistDiagnostics) {
    input.onSpecialistDiagnostic?.(diagnostic);
  }
  const model = input.specialist ? specialistModel(input.llmRuntime, input.specialist) : undefined;
  return createAgentSession({
    cwd: sandbox.root,
    noTools: "builtin",
    customTools: [...specialistSelection.tools, ...contributed.tools] as ToolDefinition<any, any, any>[],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: model?.model ?? input.llmRuntime.models.executor,
    thinkingLevel: model?.thinkingLevel ?? input.llmRuntime.roleConfig.executor.thinkingLevel,
    resourceLoader: executorLoader,
    settingsManager: createRuntimeSettingsManager(model?.contextWindow ?? input.llmRuntime.roleConfig.executor.contextWindow),
    sessionManager: input.sessionManager ?? SessionManager.inMemory(sandbox.root)
  });
}

/** Full Executor tool surface, tagged by capability group. */
export function executorToolBindings(input: {
  sandbox: ExecutorSandbox;
  artifactStore: ArtifactStore;
  additionalToolBindings?: SpecialistToolBinding[];
}): SpecialistToolBinding[] {
  const group = (group: SpecialistToolGroup, tools: ToolDefinition<any, any, any>[]): SpecialistToolBinding[] =>
    tools.map((tool) => ({ group, tool }));
  return [
    ...group("sandbox", input.sandbox.createTools()),
    ...group("research", createExecutorResearchTools()),
    ...group("osint", createExecutorOsintTools()),
    { group: "browser", tool: createBrowserRenderTool({ runtime: input.sandbox.browserRuntime, allowHostFallback: false }) },
    {
      group: "artifact",
      tool: createArtifactReadTool(input.artifactStore, {
        workspace: input.sandbox.workspaceDir
          ? {
              hostDir: input.sandbox.workspaceDir,
              visibleRoot: input.sandbox.root,
              sharedWithContainer: input.sandbox.mode === "docker"
            }
          : undefined
      })
    },
    {
      group: "artifact",
      tool: createArtifactWriteTool(input.artifactStore, {
        workspace: input.sandbox.workspaceDir
          ? { hostDir: input.sandbox.workspaceDir, visibleRoot: input.sandbox.root }
          : undefined,
        readExecutorFile: (visiblePath) => input.sandbox.readExecutorFile(visiblePath)
      })
    },
    ...(input.additionalToolBindings ?? []),
    { group: "submit", tool: createTaskResultSubmitTool() }
  ];
}

function contributeSpecialistTools(input: {
  specialist: ExecutorSpecialistInput;
  sandbox: ExecutorSandbox;
  artifactStore: ArtifactStore;
  executionLog?: ExecutionLog;
  selection: SpecialistToolSelection;
}): { tools: ToolDefinition<any, any, any>[]; diagnostics: SpecialistRegistryDiagnostic[] } {
  const createTools = input.specialist.definition.createTools;
  if (!createTools) return { tools: [], diagnostics: [] };
  const executionLog = input.executionLog;
  let produced: unknown;
  try {
    produced = createTools({
      taskId: input.specialist.taskId,
      specialistId: input.specialist.id,
      options: input.specialist.options,
      cwd: input.sandbox.hostRoot,
      workspaceDir: input.sandbox.workspaceDir,
      artifactStore: input.artifactStore,
      executionLog,
      enabledGroups: input.selection.enabledGroups,
      disabledGroups: input.selection.disabledGroups
    });
  } catch (error) {
    return {
      tools: [],
      diagnostics: [{
        code: "specialist_tool_factory_failed",
        message: `Specialist ${input.specialist.id} createTools threw: ${error instanceof Error ? error.message : String(error)}`,
        specialistId: input.specialist.id
      }]
    };
  }
  return validateSpecialistTools(produced, {
    specialistId: input.specialist.id,
    reservedNames: input.selection.tools.map((tool) => tool.name)
  });
}

function specialistModel(
  llmRuntime: LlmRuntime,
  specialist: ExecutorSpecialistInput
): { model?: NonNullable<ReturnType<LlmRuntime["modelRegistry"]["find"]>>; thinkingLevel?: LlmThinkingLevel; contextWindow?: number } {
  const profile = specialist.definition.model;
  if (!profile) return {};
  const model = profile.model
    ? llmRuntime.modelRegistry.find(llmRuntime.metadata.provider, profile.model)
    : undefined;
  return {
    ...(model ? { model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {})
  };
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
  const plannerSearchPurpose = "Find the node a planning question is about when no ref was handed to you, then read around it with graph_query focusNodeIds. Search by a domain, address, organization, technology or Task id. Do not use it to survey the graph or to re-derive facts already present in TaskOutcome.";
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [
      createGraphQueryTool(input.graphStore, undefined, undefined, graphMaterials, plannerRetrievalPurpose),
      createGraphTraceTool(input.graphStore, undefined, undefined, graphMaterials, plannerRetrievalPurpose),
      // The Planner needs a way to find a seed before it can traverse locally.
      // Traversal (graph_query with focusNodeIds, graph_trace) is bounded and
      // indexed; without search the only entry points are refs that some
      // TaskOutcome happened to name, which makes collected intelligence
      // unreachable whenever the summary does not spell out an id.
      createGraphSearchTool(input.graphStore, undefined, undefined, graphMaterials, plannerSearchPurpose),
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

export const SKILL_SELECTOR_SYSTEM_PROMPT =
  `你是任务 Skill 选择步骤。根据任务目标，从给出的已安装 Skill 元数据中选择真正有帮助的 Skill。\n` +
  `可以选择空列表；不得编造名称；不得选择与任务无关的 Skill；只调用 skill_selection_submit 一次并结束。`;

export async function createSkillSelectorAgentSession(input: {
  cwd: string;
  llmRuntime: LlmRuntime;
  providerAdmission?: ProviderAdmissionOptions;
}): Promise<CreateAgentSessionResult> {
  const loader = await createPromptLoader(input.cwd, SKILL_SELECTOR_SYSTEM_PROMPT, [], input.providerAdmission);
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [createSkillSelectionSubmitTool()],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: loader,
    settingsManager: createRuntimeSettingsManager(input.llmRuntime.roleConfig.planner.contextWindow),
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

/**
 * Single-purpose judge session for the tool approval LLM judge. Uses the
 * planner model; invocations are serialized by LlmRiskJudge.
 */
export async function createApprovalJudgeAgentSession(input: {
  cwd: string;
  llmRuntime: LlmRuntime;
}): Promise<CreateAgentSessionResult> {
  const loader = await createPromptLoader(input.cwd, APPROVAL_JUDGE_SYSTEM_PROMPT);
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [createApprovalJudgeSubmitTool()],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: "off",
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
  providerAdmission?: ProviderAdmissionOptions,
  extraExtensionFactories?: ExtensionFactory[]
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths,
    extensionFactories: [
      ...(providerAdmission
        ? [createProviderAdmissionExtension(providerAdmission)]
        : []),
      ...(extraExtensionFactories ?? [])
    ],
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
