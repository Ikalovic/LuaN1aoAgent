import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  PROTECTED_SPECIALIST_TOOL_GROUP,
  SPECIALIST_TOOL_GROUPS,
  isSpecialistToolGroup,
  type SpecialistRegistryDiagnostic,
  type SpecialistToolBinding,
  type SpecialistToolGroup,
  type SpecialistToolPolicy
} from "./types.js";

export type SpecialistToolSelection = {
  tools: ToolDefinition<any, any, any>[];
  enabledGroups: SpecialistToolGroup[];
  disabledGroups: SpecialistToolGroup[];
  removedToolNames: string[];
  diagnostics: SpecialistRegistryDiagnostic[];
};

/**
 * Narrows an assembled tool set according to a Specialist policy.
 *
 * The policy is subtractive only: groups are dropped first, then an optional
 * name allowlist narrows further, then a name denylist wins. The `submit` group
 * carries the Executor termination contract and can never be removed; a policy
 * that tries is reported as a diagnostic and ignored.
 */
export function applySpecialistToolPolicy(
  bindings: SpecialistToolBinding[],
  policy: SpecialistToolPolicy | undefined
): SpecialistToolSelection {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const requestedDisabled = new Set<SpecialistToolGroup>();
  for (const group of policy?.disableGroups ?? []) {
    if (!isSpecialistToolGroup(group)) {
      diagnostics.push({
        code: "specialist_tool_group_unknown",
        message: `Unknown Specialist tool group: ${String(group)}`
      });
      continue;
    }
    if (group === PROTECTED_SPECIALIST_TOOL_GROUP) {
      diagnostics.push({
        code: "specialist_tool_group_protected",
        message: `Tool group "${PROTECTED_SPECIALIST_TOOL_GROUP}" carries the Executor termination contract and cannot be disabled`
      });
      continue;
    }
    requestedDisabled.add(group);
  }
  const allow = normalizeNameList(policy?.allow, "allow", diagnostics);
  const deny = normalizeNameList(policy?.deny, "deny", diagnostics);
  const knownToolNames = new Set(bindings.map((binding) => binding.tool.name));

  const selected: ToolDefinition<any, any, any>[] = [];
  const removed: string[] = [];
  const enabledGroups = new Set<SpecialistToolGroup>();
  const disabledGroups = new Set<SpecialistToolGroup>();
  for (const binding of bindings) {
    const isSubmit = binding.group === PROTECTED_SPECIALIST_TOOL_GROUP;
    if (!isSubmit && requestedDisabled.has(binding.group)) {
      disabledGroups.add(binding.group);
      removed.push(binding.tool.name);
      continue;
    }
    if (deny?.has(binding.tool.name) && !isSubmit) {
      removed.push(binding.tool.name);
      continue;
    }
    if (allow && !allow.has(binding.tool.name) && !isSubmit) {
      removed.push(binding.tool.name);
      continue;
    }
    enabledGroups.add(binding.group);
    selected.push(binding.tool);
  }
  for (const name of allow ?? []) {
    if (!knownToolNames.has(name)) {
      diagnostics.push({
        code: "specialist_tool_name_unknown",
        message: `Specialist tool allowlist entry "${name}" does not match any available tool`
      });
    }
  }
  for (const name of deny ?? []) {
    if (!knownToolNames.has(name)) {
      diagnostics.push({
        code: "specialist_tool_name_unknown",
        message: `Specialist tool denylist entry "${name}" does not match any available tool`
      });
    }
  }
  if (policy?.deny?.some((name) => name === "task_result_submit")) {
    diagnostics.push({
      code: "specialist_tool_group_protected",
      message: "task_result_submit carries the Executor termination contract and cannot be denied"
    });
  }
  return {
    tools: selected,
    enabledGroups: SPECIALIST_TOOL_GROUPS.filter((group) => enabledGroups.has(group)),
    disabledGroups: SPECIALIST_TOOL_GROUPS.filter((group) => disabledGroups.has(group)),
    removedToolNames: [...new Set(removed)].sort(),
    diagnostics
  };
}

/** Group-level view of a policy, used before the concrete tool set is assembled. */
export function specialistToolGroupScope(policy: SpecialistToolPolicy | undefined): {
  enabledGroups: SpecialistToolGroup[];
  disabledGroups: SpecialistToolGroup[];
  deny: string[];
} {
  const disabled = new Set(
    (policy?.disableGroups ?? [])
      .filter(isSpecialistToolGroup)
      .filter((group) => group !== PROTECTED_SPECIALIST_TOOL_GROUP)
  );
  return {
    enabledGroups: SPECIALIST_TOOL_GROUPS.filter((group) => !disabled.has(group)),
    disabledGroups: SPECIALIST_TOOL_GROUPS.filter((group) => disabled.has(group)),
    deny: [...new Set(policy?.deny ?? [])].sort()
  };
}

/**
 * Validates tools contributed by a Specialist (code-registered or project
 * module) before they enter a session.
 */
export function validateSpecialistTools(
  tools: unknown,
  input: { specialistId: string; reservedNames: Iterable<string> }
): { tools: ToolDefinition<any, any, any>[]; diagnostics: SpecialistRegistryDiagnostic[] } {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  if (tools === undefined) return { tools: [], diagnostics };
  if (!Array.isArray(tools)) {
    diagnostics.push({
      code: "specialist_module_invalid_export",
      message: `Specialist ${input.specialistId} createTools must return an array`,
      specialistId: input.specialistId
    });
    return { tools: [], diagnostics };
  }
  const reserved = new Set(input.reservedNames);
  const accepted: ToolDefinition<any, any, any>[] = [];
  const seen = new Set<string>();
  for (const candidate of tools) {
    const name = (candidate as { name?: unknown } | undefined)?.name;
    const execute = (candidate as { execute?: unknown } | undefined)?.execute;
    if (typeof name !== "string" || name.length === 0 || typeof execute !== "function") {
      diagnostics.push({
        code: "specialist_module_invalid_export",
        message: `Specialist ${input.specialistId} returned a tool without a name or execute function`,
        specialistId: input.specialistId
      });
      continue;
    }
    if (reserved.has(name) || seen.has(name)) {
      diagnostics.push({
        code: "specialist_tool_collision",
        message: `Specialist ${input.specialistId} tool "${name}" collides with an existing tool and was dropped`,
        specialistId: input.specialistId
      });
      continue;
    }
    seen.add(name);
    accepted.push(candidate as ToolDefinition<any, any, any>);
  }
  return { tools: accepted, diagnostics };
}

function normalizeNameList(
  value: string[] | undefined,
  kind: "allow" | "deny",
  diagnostics: SpecialistRegistryDiagnostic[]
): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: "specialist_tool_policy_invalid",
      message: `Specialist tool ${kind} list must be an array of tool names`
    });
    return undefined;
  }
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      diagnostics.push({
        code: "specialist_tool_policy_invalid",
        message: `Specialist tool ${kind} list contains a non-string entry`
      });
      continue;
    }
    names.add(entry);
  }
  return names.size > 0 ? names : undefined;
}
