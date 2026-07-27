import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
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
import { normalizePlannerDecision, validatePlannerArtifactRefs } from "./planner-commands.js";
import type {
  ProjectionDraftValidationOptions,
  ProjectorGraphRefRegistry
} from "./projection.js";
import { createExecutorSandbox, type ExecutorSandbox } from "./executor-sandbox.js";
import type { ObserverMode } from "./types.js";
import {
  createArtifactReadTool,
  createArtifactWriteTool,
  createControlSubmitTool,
  createGraphDeltaSubmitTool,
  createGraphQueryTool,
  createGraphSearchTool,
  createGraphTraceTool,
  createPlannerSubmitTool,
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
}): Promise<CreateAgentSessionResult> {
  const plannerLoader = input.plannerLoader ?? await createPromptLoader(
    input.cwd,
    PLANNER_SYSTEM_PROMPT,
    [],
    input.providerAdmission
  );
  rejectUnmanagedProviderAdmission(input.plannerLoader, input.providerAdmission);
  const graphMaterials = graphToolMaterialsResolver(input.executionLog);
  return createAgentSession({
    cwd: input.cwd,
    noTools: "builtin",
    customTools: [
      createGraphQueryTool(input.graphStore, undefined, undefined, graphMaterials),
      createGraphTraceTool(input.graphStore, undefined, undefined, graphMaterials),
      createValidatedPlannerSubmitTool(input.graphStore, input.artifactStore)
    ],
    authStorage: input.llmRuntime.authStorage,
    modelRegistry: input.llmRuntime.modelRegistry,
    model: input.llmRuntime.models.planner,
    thinkingLevel: input.llmRuntime.roleConfig.planner.thinkingLevel,
    resourceLoader: plannerLoader,
    sessionManager: SessionManager.inMemory(input.cwd)
  });
}

function createValidatedPlannerSubmitTool(graphStore: SQLiteGraphStore, artifactStore: ArtifactStore) {
  return createPlannerSubmitTool({
    validate: async (value) => {
      const decision = normalizePlannerDecision(value);
      const resolved = await validatePlannerArtifactRefs(decision, () => artifactStore.list());
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
