import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_SPECIALIST_BUDGET,
  SPECIALIST_MAX_TURNS_CEILING,
  SPECIALIST_OPTION_AUTHORITIES,
  SPECIALIST_OPTIONS_MODES,
  SPECIALIST_TOOL_GROUPS,
  isPlannerTunable,
  isSpecialistId,
  isSpecialistToolGroup,
  type SpecialistAgentDefinition,
  type SpecialistBudgetProfile,
  type SpecialistOptionSpec,
  type SpecialistOptionSpecMap,
  type SpecialistOptionValue,
  type SpecialistOptionValues,
  type SpecialistRegistryDiagnostic
} from "./types.js";

export const SPECIALIST_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const SPECIALIST_OPTION_TYPES = ["string", "text", "number", "boolean", "enum", "string-list"] as const;
export const SPECIALIST_MAX_OPTIONS = 32;

export class SpecialistDefinitionError extends Error {
  constructor(message: string, readonly diagnostics: SpecialistRegistryDiagnostic[] = []) {
    super(message);
    this.name = "SpecialistDefinitionError";
  }
}

/**
 * Type-safe registration entry point for built-in and project Specialists.
 * Validates eagerly so a broken definition fails where it is declared.
 */
export function defineSpecialist(definition: SpecialistAgentDefinition): SpecialistAgentDefinition {
  const diagnostics = validateSpecialistDefinition(definition);
  if (diagnostics.length > 0) {
    throw new SpecialistDefinitionError(
      `Invalid Specialist definition ${String((definition as { id?: unknown } | undefined)?.id ?? "<unknown>")}: ${diagnostics.map((entry) => entry.message).join("; ")}`,
      diagnostics
    );
  }
  return {
    ...definition,
    budget: { ...definition.budget }
  };
}

/** Non-throwing validation used for manifests and project modules. */
export function validateSpecialistDefinition(value: unknown): SpecialistRegistryDiagnostic[] {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const push = (code: string, message: string, specialistId?: string): void => {
    diagnostics.push({ code, message, ...(specialistId ? { specialistId } : {}) });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    push("specialist_manifest_invalid", "Specialist definition must be an object");
    return diagnostics;
  }
  const definition = value as Partial<SpecialistAgentDefinition>;
  if (!isSpecialistId(definition.id)) {
    push("specialist_id_invalid", `Specialist id must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 64 characters: ${String(definition.id)}`);
    return diagnostics;
  }
  const id = definition.id;
  if (typeof definition.name !== "string" || definition.name.trim().length === 0) {
    push("specialist_manifest_invalid", "Specialist name is required", id);
  }
  if (typeof definition.description !== "string" || definition.description.trim().length === 0) {
    push("specialist_manifest_invalid", "Specialist description is required", id);
  }
  if (definition.whenToUse !== undefined && typeof definition.whenToUse !== "string") {
    push("specialist_manifest_invalid", "Specialist whenToUse must be a string", id);
  }
  if (definition.version !== undefined && typeof definition.version !== "string") {
    push("specialist_manifest_invalid", "Specialist version must be a string", id);
  }
  const prompt = definition.prompt as { mode?: unknown; content?: unknown } | undefined;
  if (!prompt || typeof prompt !== "object") {
    push("specialist_manifest_invalid", "Specialist prompt is required", id);
  } else {
    if (prompt.mode !== "extend" && prompt.mode !== "replace") {
      push("specialist_manifest_invalid", 'Specialist prompt.mode must be "extend" or "replace"', id);
    }
    if (typeof prompt.content !== "string") {
      push("specialist_manifest_invalid", "Specialist prompt.content must be a string", id);
    }
  }
  diagnostics.push(...validateBudget(definition.budget, id));
  diagnostics.push(...validateToolPolicy(definition.tools, id));
  diagnostics.push(...validateSkillPolicy(definition.skills, id));
  diagnostics.push(...validateOptionsMode(definition.optionsMode, id));
  diagnostics.push(...validateOptionsSpec(definition.options, id));
  if (definition.createTools !== undefined && typeof definition.createTools !== "function") {
    push("specialist_manifest_invalid", "Specialist createTools must be a function", id);
  }
  if (definition.model !== undefined) {
    const model = definition.model as Record<string, unknown>;
    if (model.model !== undefined && typeof model.model !== "string") {
      push("specialist_manifest_invalid", "Specialist model.model must be a string", id);
    }
    if (model.thinkingLevel !== undefined
      && !(SPECIALIST_THINKING_LEVELS as readonly unknown[]).includes(model.thinkingLevel)) {
      push("specialist_manifest_invalid", `Specialist model.thinkingLevel must be one of ${SPECIALIST_THINKING_LEVELS.join(", ")}`, id);
    }
    if (model.contextWindow !== undefined
      && (typeof model.contextWindow !== "number" || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0)) {
      push("specialist_manifest_invalid", "Specialist model.contextWindow must be a positive number", id);
    }
  }
  if (definition.concurrency !== undefined) {
    const maxParallelTasks = (definition.concurrency as Record<string, unknown>).maxParallelTasks;
    if (maxParallelTasks !== undefined
      && (!Number.isInteger(maxParallelTasks) || (maxParallelTasks as number) < 1 || (maxParallelTasks as number) > 16)) {
      push("specialist_manifest_invalid", "Specialist concurrency.maxParallelTasks must be an integer between 1 and 16", id);
    }
  }
  return diagnostics;
}

function validateBudget(value: unknown, id: string): SpecialistRegistryDiagnostic[] {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const push = (message: string): void => {
    diagnostics.push({ code: "specialist_manifest_invalid", message, specialistId: id });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    push("Specialist budget is required");
    return diagnostics;
  }
  const budget = value as Partial<SpecialistBudgetProfile>;
  const bounds: Array<{ key: keyof SpecialistBudgetProfile; min: number; max: number; integer: boolean }> = [
    { key: "defaultMaxTurns", min: 1, max: SPECIALIST_MAX_TURNS_CEILING, integer: true },
    { key: "maxTurnsCeiling", min: 1, max: SPECIALIST_MAX_TURNS_CEILING, integer: true },
    { key: "epochTurnSlice", min: 1, max: SPECIALIST_MAX_TURNS_CEILING, integer: true },
    { key: "epochTimeShare", min: Number.EPSILON, max: 1, integer: false }
  ];
  for (const bound of bounds) {
    const raw = budget[bound.key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < bound.min || raw > bound.max
      || (bound.integer && !Number.isInteger(raw))) {
      push(`Specialist budget.${bound.key} must be ${bound.integer ? "an integer" : "a number"} between ${bound.min} and ${bound.max}`);
    }
  }
  if (typeof budget.defaultMaxTurns === "number" && typeof budget.maxTurnsCeiling === "number"
    && budget.defaultMaxTurns > budget.maxTurnsCeiling) {
    push("Specialist budget.defaultMaxTurns must not exceed budget.maxTurnsCeiling");
  }
  return diagnostics;
}

function validateToolPolicy(value: unknown, id: string): SpecialistRegistryDiagnostic[] {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const push = (message: string): void => {
    diagnostics.push({ code: "specialist_manifest_invalid", message, specialistId: id });
  };
  if (value === undefined) return diagnostics;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    push("Specialist tools policy must be an object");
    return diagnostics;
  }
  const policy = value as Record<string, unknown>;
  if (policy.disableGroups !== undefined) {
    if (!Array.isArray(policy.disableGroups)) {
      push("Specialist tools.disableGroups must be an array");
    } else {
      for (const group of policy.disableGroups) {
        if (!isSpecialistToolGroup(group)) {
          push(`Unknown Specialist tool group "${String(group)}"; expected one of ${SPECIALIST_TOOL_GROUPS.join(", ")}`);
        }
      }
    }
  }
  for (const key of ["allow", "deny"] as const) {
    if (policy[key] !== undefined && (!Array.isArray(policy[key]) || (policy[key] as unknown[]).some((entry) => typeof entry !== "string"))) {
      push(`Specialist tools.${key} must be an array of tool names`);
    }
  }
  return diagnostics;
}

function validateSkillPolicy(value: unknown, id: string): SpecialistRegistryDiagnostic[] {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const push = (message: string): void => {
    diagnostics.push({ code: "specialist_manifest_invalid", message, specialistId: id });
  };
  if (value === undefined) return diagnostics;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    push("Specialist skills policy must be an object");
    return diagnostics;
  }
  const policy = value as Record<string, unknown>;
  if (!["auto", "allowlist", "pinned", "off"].includes(String(policy.mode))) {
    push('Specialist skills.mode must be one of auto, allowlist, pinned, off');
    return diagnostics;
  }
  if (policy.mode === "pinned" && (!Array.isArray(policy.pinned) || policy.pinned.length === 0)) {
    push("Specialist skills.pinned must list at least one skill when mode=pinned");
  }
  if (policy.mode === "allowlist" && (!Array.isArray(policy.allow) || policy.allow.length === 0)) {
    push("Specialist skills.allow must list at least one skill when mode=allowlist");
  }
  return diagnostics;
}

function validateOptionsMode(value: unknown, id: string): SpecialistRegistryDiagnostic[] {
  if (value === undefined) return [];
  if (!(SPECIALIST_OPTIONS_MODES as readonly unknown[]).includes(value)) {
    return [{
      code: "specialist_manifest_invalid",
      message: `Specialist optionsMode must be one of ${SPECIALIST_OPTIONS_MODES.join(", ")}`,
      specialistId: id
    }];
  }
  return [];
}

function validateOptionsSpec(value: unknown, id: string): SpecialistRegistryDiagnostic[] {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const push = (message: string): void => {
    diagnostics.push({ code: "specialist_manifest_invalid", message, specialistId: id });
  };
  if (value === undefined) return diagnostics;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    push("Specialist options must be an object keyed by option name");
    return diagnostics;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SPECIALIST_MAX_OPTIONS) {
    push(`Specialist options must not exceed ${SPECIALIST_MAX_OPTIONS} entries`);
  }
  for (const [key, spec] of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      push(`Specialist option key "${key}" must match ^[A-Za-z0-9_-]+$`);
      continue;
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      push(`Specialist option "${key}" must be an object`);
      continue;
    }
    const record = spec as Record<string, unknown>;
    if (!(SPECIALIST_OPTION_TYPES as readonly unknown[]).includes(record.type)) {
      push(`Specialist option "${key}" type must be one of ${SPECIALIST_OPTION_TYPES.join(", ")}`);
      continue;
    }
    if (typeof record.title !== "string" || record.title.trim().length === 0) {
      push(`Specialist option "${key}" requires a title`);
    }
    if (record.type === "enum") {
      const options = record.options;
      if (!Array.isArray(options) || options.length === 0
        || options.some((entry) => !entry || typeof entry !== "object"
          || typeof (entry as Record<string, unknown>).value !== "string"
          || typeof (entry as Record<string, unknown>).label !== "string")) {
        push(`Specialist option "${key}" requires options as [{ value, label }]`);
      }
    }
    // The authority model only gives "the operator declares a boundary" a
    // well-defined meaning for numbers and string lists. Every other type must
    // be either author-fixed or operator-owned, so an unsupported combination
    // fails here rather than becoming an option the UI cannot render honestly.
    if (record.authority !== undefined
      && !(SPECIALIST_OPTION_AUTHORITIES as readonly unknown[]).includes(record.authority)) {
      push(`Specialist option "${key}" authority must be one of ${SPECIALIST_OPTION_AUTHORITIES.join(", ")}`);
      continue;
    }
    if (record.authority === "planner" && !isPlannerTunable(record as SpecialistOptionSpec)) {
      push(`Specialist option "${key}" cannot use authority "planner": it requires a number with a maximum, or a string-list with a non-empty default to narrow`);
      continue;
    }
  }
  return diagnostics;
}

/**
 * Merges stored option values with schema defaults, coercing and validating
 * each entry. Unknown keys are rejected so stored state cannot smuggle values
 * into a session.
 */
export function normalizeSpecialistOptions(
  spec: SpecialistOptionSpecMap | undefined,
  raw: unknown
): { values: SpecialistOptionValues; diagnostics: SpecialistRegistryDiagnostic[]; unknownKeys: string[] } {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const values = defaultSpecialistOptions(spec);
  const unknownKeys: string[] = [];
  if (raw === undefined || raw === null) return { values, diagnostics, unknownKeys };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push({ code: "specialist_option_invalid", message: "Specialist options must be an object" });
    return { values, diagnostics, unknownKeys };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const optionSpec = spec?.[key];
    if (!optionSpec) {
      unknownKeys.push(key);
      diagnostics.push({ code: "specialist_option_unknown", message: `Unknown Specialist option "${key}"` });
      continue;
    }
    if (value === undefined) continue;
    const normalized = normalizeOptionValue(optionSpec, value);
    if (normalized === undefined) {
      diagnostics.push({ code: "specialist_option_invalid", message: `Invalid value for Specialist option "${key}"` });
      continue;
    }
    values[key] = normalized;
  }
  return { values, diagnostics, unknownKeys };
}

export function defaultSpecialistOptions(spec: SpecialistOptionSpecMap | undefined): SpecialistOptionValues {
  const values: SpecialistOptionValues = {};
  for (const [key, optionSpec] of Object.entries(spec ?? {})) {
    const value = optionSpec.default;
    if (value !== undefined) values[key] = Array.isArray(value) ? [...value] : value;
  }
  return values;
}

/** Type-appropriate fallback used when an option declares no default. */
export function emptyOptionValue(spec: SpecialistOptionSpec): SpecialistOptionValue {
  switch (spec.type) {
    case "boolean":
      return false;
    case "number":
      return spec.minimum ?? 0;
    case "string-list":
      return [];
    case "enum":
      return spec.options[0]?.value ?? "";
    default:
      return "";
  }
}

/** Validates a single option value against its spec; returns undefined when invalid. */
export function normalizeOptionValue(spec: SpecialistOptionSpec, value: unknown): SpecialistOptionValue | undefined {
  switch (spec.type) {
    case "string":
    case "text": {
      if (typeof value !== "string") return undefined;
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return undefined;
      if (spec.type === "string" && spec.pattern !== undefined) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(spec.pattern);
        } catch {
          return undefined;
        }
        if (!pattern.test(value)) return undefined;
      }
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      if (spec.integer !== false && !Number.isInteger(value)) return undefined;
      if (spec.minimum !== undefined && value < spec.minimum) return undefined;
      if (spec.maximum !== undefined && value > spec.maximum) return undefined;
      return value;
    }
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "enum": {
      if (typeof value !== "string") return undefined;
      return spec.options.some((option) => option.value === value) ? value : undefined;
    }
    case "string-list": {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return undefined;
      return [...value] as string[];
    }
    default:
      return undefined;
  }
}

/** Convenience wrapper so project modules can define tools without importing the Pi SDK directly. */
export function defineSpecialistTool(tool: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
  return defineTool(tool as never) as unknown as ToolDefinition<any, any, any>;
}

/**
 * API object handed to project-level Specialist modules. Modules may import the
 * Pi SDK directly as well; this object exists so a module can be written without
 * depending on the repository's dependency layout.
 */
export const SPECIALIST_MODULE_API = {
  Type,
  defineTool,
  defineSpecialist,
  defineSpecialistTool,
  toolGroups: SPECIALIST_TOOL_GROUPS,
  defaultBudget: DEFAULT_SPECIALIST_BUDGET
} as const;

export type SpecialistModuleApi = typeof SPECIALIST_MODULE_API;
