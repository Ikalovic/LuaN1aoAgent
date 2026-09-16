import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LlmThinkingLevel } from "../llm-config.js";
import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";

/**
 * Tool capability groups. A group maps 1:1 onto one Executor tool factory so a
 * Specialist can only ever narrow the tool surface, never widen it.
 */
export const SPECIALIST_TOOL_GROUPS = [
  "sandbox",
  "research",
  "browser",
  "artifact",
  "evidence",
  "connectivity",
  "network_diagnostics",
  "fofa",
  "beekeeper",
  "credentials",
  "submit"
] as const;

export type SpecialistToolGroup = typeof SPECIALIST_TOOL_GROUPS[number];

/** The Executor termination contract. Never removable by a Specialist. */
export const PROTECTED_SPECIALIST_TOOL_GROUP: SpecialistToolGroup = "submit";

export type SpecialistToolPolicy = {
  disableGroups?: SpecialistToolGroup[];
  allow?: string[];
  deny?: string[];
};

export type SpecialistBudgetProfile = {
  /** Used when the Planner omits budget.maxTurns. */
  defaultMaxTurns: number;
  /** Upper bound applied to Planner-provided maxTurns and additionalTurns patches. */
  maxTurnsCeiling: number;
  /** Turns allowed inside a single Executor epoch. */
  epochTurnSlice: number;
  /** Share of the remaining global run time allowed for one epoch (0 < s <= 1). */
  epochTimeShare: number;
};

export type SpecialistModelProfile = {
  model?: string;
  thinkingLevel?: LlmThinkingLevel;
  contextWindow?: number;
};

export type SpecialistSkillPolicy = {
  mode: "auto" | "allowlist" | "pinned" | "off";
  /** Candidate restriction for mode=allowlist. */
  allow?: string[];
  /** Fixed selection for mode=pinned. */
  pinned?: string[];
};

/**
 * Who owns an option's effective value, ordered from most to least restrictive.
 *
 * - `author`: the declared default is final. No online role may change it and
 *   the capability page renders it read-only. This is where a Specialist author
 *   pins its safety envelope.
 * - `planner`: the operator may only declare a boundary (an upper bound for a
 *   number, a narrowed subset for a string list); the Planner picks the concrete
 *   value per Task inside that boundary.
 * - `user`: the operator's stored value is used directly, still clamped by the
 *   author's hard bounds.
 */
export const SPECIALIST_OPTION_AUTHORITIES = ["author", "planner", "user"] as const;

export type SpecialistOptionAuthority = typeof SPECIALIST_OPTION_AUTHORITIES[number];

/** Authority ordering used when an option-level override tightens the Agent mode. */
export const SPECIALIST_OPTION_AUTHORITY_RANK: Record<SpecialistOptionAuthority, number> = {
  author: 0,
  planner: 1,
  user: 2
};

/**
 * Agent-level default authority for options that do not declare their own.
 * The author sets the default; the capability page may switch it, and any
 * option-level override still applies on top as a tightening only.
 */
export const SPECIALIST_OPTIONS_MODES = ["planner", "user"] as const;

export type SpecialistOptionsMode = typeof SPECIALIST_OPTIONS_MODES[number];

/**
 * Option-level tightening. `planner` is only meaningful for `number` and
 * `string-list`, where "the operator declares a boundary" has an unambiguous
 * meaning; `defineSpecialist` rejects it on every other type.
 */
export type SpecialistOptionAuthorityOverride = SpecialistOptionAuthority;

export type SpecialistOptionSpec =
  | {
      type: "string";
      title: string;
      description?: string;
      default?: string;
      pattern?: string;
      maxLength?: number;
      placeholder?: string;
      authority?: SpecialistOptionAuthorityOverride;
    }
  | {
      type: "text";
      title: string;
      description?: string;
      default?: string;
      maxLength?: number;
      placeholder?: string;
      authority?: SpecialistOptionAuthorityOverride;
    }
  | {
      type: "number";
      title: string;
      description?: string;
      default?: number;
      minimum?: number;
      maximum?: number;
      integer?: boolean;
      authority?: SpecialistOptionAuthorityOverride;
    }
  | {
      type: "boolean";
      title: string;
      description?: string;
      default?: boolean;
      authority?: SpecialistOptionAuthorityOverride;
    }
  | {
      type: "enum";
      title: string;
      description?: string;
      default?: string;
      options: Array<{ value: string; label: string }>;
      authority?: SpecialistOptionAuthorityOverride;
    }
  | {
      type: "string-list";
      title: string;
      description?: string;
      default?: string[];
      maxItems?: number;
      authority?: SpecialistOptionAuthorityOverride;
    };

export type SpecialistOptionSpecMap = Record<string, SpecialistOptionSpec>;

/** Option types for which `planner` authority is well defined. */
export const SPECIALIST_PLANNER_TUNABLE_OPTION_TYPES = ["number", "string-list"] as const;

/**
 * An option is Planner-tunable only when "the operator declares a boundary" has
 * a well-defined meaning *and* the author actually declared that boundary: a
 * number needs a `maximum`, a string list needs a non-empty authorized superset
 * to narrow. Anything else can never become an unbounded Planner knob.
 */
export function isPlannerTunable(spec: SpecialistOptionSpec): boolean {
  if (spec.type === "number") return typeof spec.maximum === "number";
  if (spec.type === "string-list") return Array.isArray(spec.default) && spec.default.length > 0;
  return false;
}

/**
 * Effective boundary for an option, after intersecting the author's hard bounds
 * with whatever boundary the operator declared.
 */
export type SpecialistOptionBounds = {
  minimum?: number;
  maximum?: number;
  allowed?: string[];
};

/** Per-option resolution result, used to clamp Planner values at Task creation. */
export type SpecialistOptionPolicy = {
  key: string;
  spec: SpecialistOptionSpec;
  authority: SpecialistOptionAuthority;
  bounds?: SpecialistOptionBounds;
  authorDefault?: SpecialistOptionValue;
  /** Operator-supplied value, interpreted as a boundary or as a value per authority. */
  userValue?: SpecialistOptionValue;
  /** Value in force before any Task-level override; the fallback for every authority. */
  effective?: SpecialistOptionValue;
};

export type SpecialistOptionPolicyMap = Record<string, SpecialistOptionPolicy>;

/**
 * Planner-facing description of an option the Planner may pick a value for.
 * Only `planner` authority options appear here: the author's capability
 * decisions and the operator's own parameters stay out of the Planner's
 * writable view.
 */
export type SpecialistPlannerTunableOption = {
  key: string;
  type: typeof SPECIALIST_PLANNER_TUNABLE_OPTION_TYPES[number];
  title: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  allowed?: string[];
  current?: SpecialistOptionValue;
  /** Machine-readable instruction for how the Planner should fill the value. */
  hint: string;
};

export type SpecialistOptionValue = string | number | boolean | string[];

export type SpecialistOptionValues = Record<string, SpecialistOptionValue>;

export type SpecialistToolContext = {
  taskId: string;
  specialistId: string;
  options: SpecialistOptionValues;
  cwd: string;
  workspaceDir?: string;
  artifactStore: ArtifactStore;
  /** Present when the runtime created this session with an execution log. */
  executionLog?: ExecutionLog;
  /** Groups that survived the Specialist tool policy, for author-side diagnostics. */
  enabledGroups: SpecialistToolGroup[];
  disabledGroups: SpecialistToolGroup[];
};

export type SpecialistAgentDefinition = {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  version?: string;
  /** extend = EXECUTOR_SYSTEM_PROMPT plus the Specialist section; replace = author content only. */
  prompt: {
    mode: "extend" | "replace";
    content: string;
  };
  tools?: SpecialistToolPolicy;
  createTools?: (context: SpecialistToolContext) => ToolDefinition<any, any, any>[];
  skills?: SpecialistSkillPolicy;
  budget: SpecialistBudgetProfile;
  model?: SpecialistModelProfile;
  concurrency?: {
    maxParallelTasks?: number;
  };
  /**
   * Default authority for options without their own override. The capability
   * page may switch this at run time; `author` bounds still apply regardless.
   */
  optionsMode?: SpecialistOptionsMode;
  options?: SpecialistOptionSpecMap;
};

export type SpecialistRegistryDiagnostic = {
  code: string;
  message: string;
  specialistId?: string;
  path?: string;
};

export type RegisteredSpecialistOption = {
  key: string;
  spec: SpecialistOptionSpec;
  value: SpecialistOptionValue;
  isDefault: boolean;
  /** Effective authority after the Agent mode and the option-level tightening. */
  authority: SpecialistOptionAuthority;
  /** False only for `author` authority: the capability page renders these read-only. */
  editable: boolean;
  /** True when the operator's editable value is a boundary rather than the value itself. */
  boundOnly: boolean;
  bounds?: SpecialistOptionBounds;
  authorDefault?: SpecialistOptionValue;
};

export type RegisteredSpecialist = {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  version?: string;
  source: "builtin" | "project";
  enabled: boolean;
  valid: boolean;
  /** Whether the definition is fully known (a project module still needs loading). */
  introspected: boolean;
  executability: "prompt-only" | "module";
  promptMode: SpecialistAgentDefinition["prompt"]["mode"];
  enabledGroups: SpecialistToolGroup[];
  disabledGroups: SpecialistToolGroup[];
  deniedTools: string[];
  skillMode: SpecialistSkillPolicy["mode"];
  budget: SpecialistBudgetProfile;
  concurrency?: { maxParallelTasks?: number };
  /** Mode in force now. */
  optionsMode: SpecialistOptionsMode;
  /** Mode the author declared; what the capability page resets to. */
  authorOptionsMode: SpecialistOptionsMode;
  options: RegisteredSpecialistOption[];
  diagnostics: SpecialistRegistryDiagnostic[];
};

export type SpecialistRegistrySnapshot = {
  scannedAt: string;
  specialists: RegisteredSpecialist[];
  diagnostics: SpecialistRegistryDiagnostic[];
};

/** Compact Planner-facing catalog entry: no option specs, no prompt text. */
export type SpecialistCatalogEntry = {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  budget: SpecialistBudgetProfile;
  skillMode: SpecialistSkillPolicy["mode"];
  disabledToolGroups: SpecialistToolGroup[];
  maxParallelTasks?: number;
  /**
   * Options the Planner may pick a value for, already reduced to the effective
   * boundary. Absent when the Specialist exposes no planner-tunable option.
   */
  tunableOptions?: SpecialistPlannerTunableOption[];
};

export type SpecialistUnavailableReason = "unknown" | "disabled" | "invalid" | "load_failed";

export type SpecialistResolution =
  | {
      ok: true;
      id: string;
      definition: SpecialistAgentDefinition;
      /** Effective values, safe to render into prompts. */
      options: SpecialistOptionValues;
      /** Per-option authority and boundary, used to clamp Planner values. */
      optionPolicies: SpecialistOptionPolicyMap;
      entry: RegisteredSpecialist;
      diagnostics: SpecialistRegistryDiagnostic[];
    }
  | {
      ok: false;
      id: string;
      reason: SpecialistUnavailableReason;
      message: string;
      entry?: RegisteredSpecialist;
    };

export type SpecialistToolBinding = {
  group: SpecialistToolGroup;
  tool: ToolDefinition<any, any, any>;
};

export const DEFAULT_SPECIALIST_BUDGET: SpecialistBudgetProfile = {
  defaultMaxTurns: 12,
  maxTurnsCeiling: 40,
  epochTurnSlice: 20,
  epochTimeShare: 0.5
};

export const SPECIALIST_MAX_TURNS_CEILING = 40;

export const SPECIALIST_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSpecialistId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && SPECIALIST_ID_PATTERN.test(value);
}

export function isSpecialistToolGroup(value: unknown): value is SpecialistToolGroup {
  return typeof value === "string" && (SPECIALIST_TOOL_GROUPS as readonly string[]).includes(value);
}
