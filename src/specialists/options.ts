import {
  SPECIALIST_OPTION_AUTHORITY_RANK,
  SPECIALIST_OPTIONS_MODES,
  isPlannerTunable,
  type SpecialistAgentDefinition,
  type SpecialistOptionAuthority,
  type SpecialistOptionAuthorityOverride,
  type SpecialistOptionBounds,
  type SpecialistOptionPolicy,
  type SpecialistOptionPolicyMap,
  type SpecialistOptionSpec,
  type SpecialistOptionValue,
  type SpecialistOptionValues,
  type SpecialistOptionsMode,
  type SpecialistPlannerTunableOption,
  type SpecialistRegistryDiagnostic
} from "./types.js";
import { emptyOptionValue, normalizeOptionValue } from "./sdk.js";

/**
 * Option authority resolution.
 *
 * Three authorities exist, ordered from most to least restrictive:
 * `author` (only the Specialist author decides), `planner` (the operator
 * declares a boundary and the Planner picks a value inside it) and `user` (the
 * operator's value is used directly). The Agent-level mode supplies the default
 * and an option-level override may only ever tighten it, so neither the Planner
 * nor an operator on the capability page can widen what the author declared.
 *
 * Every function here is pure: the registry, the controller and the tests share
 * exactly one implementation of these rules.
 */

export type ResolvedSpecialistOptions = {
  mode: SpecialistOptionsMode;
  /** Effective values, safe to render into prompts. */
  values: SpecialistOptionValues;
  /** Per-key authority and boundary, used to clamp Planner values per Task. */
  policies: SpecialistOptionPolicyMap;
  /**
   * The operator-editable slice of the resolved values, already clamped and
   * interpreted per authority. This is what the state file persists.
   */
  userValues: SpecialistOptionValues;
  diagnostics: SpecialistRegistryDiagnostic[];
};

function diagnostic(
  code: string,
  message: string,
  specialistId?: string
): SpecialistRegistryDiagnostic {
  return { code, message, ...(specialistId ? { specialistId } : {}) };
}

export function isSpecialistOptionsMode(value: unknown): value is SpecialistOptionsMode {
  return typeof value === "string" && (SPECIALIST_OPTIONS_MODES as readonly string[]).includes(value);
}

export function isSpecialistOptionAuthority(value: unknown): value is SpecialistOptionAuthority {
  return typeof value === "string" && value in SPECIALIST_OPTION_AUTHORITY_RANK;
}

/**
 * The more restrictive of the Agent mode and the option-level override wins.
 *
 * - `authority: "author"` is an absolute lock.
 * - `authority: "planner"` is honoured only where it is well defined; elsewhere
 *   it degrades to a lock rather than inventing boundary semantics.
 * - `authority: "user"` is an explicit hand-off by the author.
 * - Without an override, the Agent mode decides for options the Planner can
 *   tune, and the fail-safe posture applies to everything else: with the default
 *   `planner` mode those become author-locked instead of freely editable.
 */
export function effectiveOptionAuthority(
  mode: SpecialistOptionsMode,
  override: SpecialistOptionAuthorityOverride | undefined,
  spec: SpecialistOptionSpec
): SpecialistOptionAuthority {
  if (override === "author") return "author";
  if (override === "user") return "user";
  const tunable = isPlannerTunable(spec);
  if (override === "planner") return tunable ? "planner" : "author";
  if (!tunable) return mode === "user" ? "user" : "author";
  return mode;
}

/** Author default, falling back to a type-appropriate empty value. */
export function optionAuthorDefault(spec: SpecialistOptionSpec): SpecialistOptionValue {
  return spec.default !== undefined
    ? (Array.isArray(spec.default) ? [...spec.default] : spec.default)
    : emptyOptionValue(spec);
}

export type NumberOptionSpec = Extract<SpecialistOptionSpec, { type: "number" }>;
export type StringListOptionSpec = Extract<SpecialistOptionSpec, { type: "string-list" }>;

function clampNumberToBounds(value: number, bounds: SpecialistOptionBounds, spec: NumberOptionSpec): number {
  let next = value;
  if (spec.integer !== false) next = Math.floor(next);
  if (bounds.minimum !== undefined) next = Math.max(next, bounds.minimum);
  if (bounds.maximum !== undefined) next = Math.min(next, bounds.maximum);
  return next;
}

function clampStringListToBounds(
  value: string[],
  allowed: string[] | undefined,
  spec: SpecialistOptionSpec
): string[] {
  const narrowed = allowed ? value.filter((entry) => allowed.includes(entry)) : value;
  const deduped = [...new Set(narrowed)];
  return spec.type === "string-list" && spec.maxItems !== undefined
    ? deduped.slice(0, spec.maxItems)
    : deduped;
}

/** Human-readable constraint summary, so a rejected write explains itself. */
export function describeOptionConstraint(spec: SpecialistOptionSpec): string {
  switch (spec.type) {
    case "number": {
      const kind = spec.integer === false ? "a number" : "an integer";
      if (spec.minimum !== undefined && spec.maximum !== undefined) {
        return `must be ${kind} between ${spec.minimum} and ${spec.maximum}`;
      }
      if (spec.minimum !== undefined) return `must be ${kind} >= ${spec.minimum}`;
      if (spec.maximum !== undefined) return `must be ${kind} <= ${spec.maximum}`;
      return `must be ${kind}`;
    }
    case "enum":
      return `must be one of ${spec.options.map((option) => option.value).join(", ")}`;
    case "string-list":
      return spec.maxItems !== undefined
        ? `must be an array of at most ${spec.maxItems} strings`
        : "must be an array of strings";
    case "string":
      return spec.pattern !== undefined
        ? `must be a string matching ${spec.pattern}`
        : "must be a string";
    default:
      return "must be a string";
  }
}

function resolveOne(
  key: string,
  spec: SpecialistOptionSpec,
  rawUserValue: unknown,
  authority: SpecialistOptionAuthority,
  specialistId: string
): {
  value: SpecialistOptionValue;
  policy: SpecialistOptionPolicy;
  userValue?: SpecialistOptionValue;
  diagnostics: SpecialistRegistryDiagnostic[];
} {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const authorDefault = optionAuthorDefault(spec);
  const hasRaw = rawUserValue !== undefined && rawUserValue !== null;
  const normalizedUser = hasRaw ? normalizeOptionValue(spec, rawUserValue) : undefined;
  if (hasRaw && normalizedUser === undefined) {
    diagnostics.push(diagnostic(
      "specialist_option_invalid",
      `Specialist option "${key}" ${describeOptionConstraint(spec)}`,
      specialistId
    ));
  }
  const policy: SpecialistOptionPolicy = {
    key,
    spec,
    authority,
    authorDefault
  };

  if (authority === "author") {
    if (hasRaw) {
      diagnostics.push(diagnostic(
        "specialist_option_not_editable",
        `Specialist option "${key}" is fixed by the Specialist author and cannot be configured`,
        specialistId
      ));
    }
    return { value: Array.isArray(authorDefault) ? [...authorDefault] : authorDefault, policy, diagnostics };
  }

  if (authority === "planner") {
    if (spec.type === "number") {
      const authorMinimum = spec.minimum;
      const authorMaximum = spec.maximum;
      let effectiveMaximum = authorMaximum;
      let userBound: number | undefined;
      if (typeof normalizedUser === "number") {
        if (authorMinimum !== undefined && normalizedUser < authorMinimum) {
          diagnostics.push(diagnostic(
            "specialist_option_bound_below_minimum",
            `Specialist option "${key}" bound ${normalizedUser} is below the author minimum ${authorMinimum}; the author maximum applies instead`,
            specialistId
          ));
        } else {
          userBound = authorMaximum !== undefined
            ? Math.min(normalizedUser, authorMaximum)
            : normalizedUser;
          effectiveMaximum = userBound;
        }
      }
      const bounds: SpecialistOptionBounds = {
        ...(authorMinimum !== undefined ? { minimum: authorMinimum } : {}),
        ...(effectiveMaximum !== undefined ? { maximum: effectiveMaximum } : {})
      };
      const fallback = typeof authorDefault === "number" ? authorDefault : (authorMinimum ?? 0);
      const value = clampNumberToBounds(fallback, bounds, spec);
      const withBounds: SpecialistOptionPolicy = {
        ...policy,
        bounds,
        ...(userBound !== undefined ? { userValue: userBound } : {})
      };
      return { value, policy: withBounds, ...(userBound !== undefined ? { userValue: userBound } : {}), diagnostics };
    }
    // string-list: the author default is the authorized superset, the operator
    // may only narrow it, and the Planner picks from what survives.
    const authorSet = Array.isArray(authorDefault) ? authorDefault : [];
    let allowed = authorSet;
    let userList: string[] | undefined;
    if (Array.isArray(normalizedUser)) {
      if (authorSet.length === 0) {
        allowed = normalizedUser;
      } else {
        const narrowed = authorSet.filter((entry) => normalizedUser.includes(entry));
        if (narrowed.length === 0) {
          diagnostics.push(diagnostic(
            "specialist_option_bound_excludes_all",
            `Specialist option "${key}" selection excludes every authorized entry; the author set applies instead`,
            specialistId
          ));
        } else {
          allowed = narrowed;
        }
      }
      userList = allowed;
    }
    const bounds: SpecialistOptionBounds = { allowed: [...allowed] };
    const withBounds: SpecialistOptionPolicy = {
      ...policy,
      bounds,
      ...(userList !== undefined ? { userValue: [...userList] } : {})
    };
    return {
      value: [...allowed],
      policy: withBounds,
      ...(userList !== undefined ? { userValue: [...userList] } : {}),
      diagnostics
    };
  }

  // authority === "user": the operator's value wins, clamped by author bounds.
  const candidate = normalizedUser ?? authorDefault;
  let value: SpecialistOptionValue;
  if (typeof candidate === "number" && spec.type === "number") {
    const bounds: SpecialistOptionBounds = {
      ...(spec.minimum !== undefined ? { minimum: spec.minimum } : {}),
      ...(spec.maximum !== undefined ? { maximum: spec.maximum } : {})
    };
    value = clampNumberToBounds(candidate, bounds, spec);
  } else if (Array.isArray(candidate)) {
    value = clampStringListToBounds(candidate, undefined, spec);
  } else {
    value = candidate;
  }
  const clamped = normalizedUser !== undefined && !valuesEqual(value, normalizedUser);
  if (clamped) {
    diagnostics.push(diagnostic(
      "specialist_option_clamped",
      `Specialist option "${key}" was clamped to the author bounds`,
      specialistId
    ));
  }
  const withValue: SpecialistOptionPolicy = {
    ...policy,
    ...(normalizedUser !== undefined ? { userValue: value } : {})
  };
  const userValue = withValue.userValue;
  return {
    value,
    policy: withValue,
    ...(userValue !== undefined ? { userValue } : {}),
    diagnostics
  };
}

/**
 * Resolves every option of a definition against the stored operator state.
 * Unknown stored keys are reported and dropped so stale state cannot smuggle
 * values into a session.
 */
export function resolveSpecialistOptions(
  definition: Pick<SpecialistAgentDefinition, "id" | "options" | "optionsMode">,
  rawUserOptions: unknown,
  rawOptionsMode?: unknown
): ResolvedSpecialistOptions {
  const specialistId = definition.id;
  const authorMode: SpecialistOptionsMode = definition.optionsMode ?? "planner";
  const mode = isSpecialistOptionsMode(rawOptionsMode) ? rawOptionsMode : authorMode;
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const values: SpecialistOptionValues = {};
  const policies: SpecialistOptionPolicyMap = {};
  const userValues: SpecialistOptionValues = {};
  const spec = definition.options ?? {};
  const raw: Record<string, unknown> = rawUserOptions && typeof rawUserOptions === "object" && !Array.isArray(rawUserOptions)
    ? rawUserOptions as Record<string, unknown>
    : {};
  if (rawUserOptions !== undefined && rawUserOptions !== null && (typeof rawUserOptions !== "object" || Array.isArray(rawUserOptions))) {
    diagnostics.push(diagnostic("specialist_option_invalid", "Specialist options must be an object", specialistId));
  }
  for (const key of Object.keys(raw)) {
    if (!(key in spec)) {
      diagnostics.push(diagnostic("specialist_option_unknown", `Unknown Specialist option "${key}"`, specialistId));
    }
  }
  for (const [key, optionSpec] of Object.entries(spec)) {
    const authority = effectiveOptionAuthority(mode, optionSpec.authority, optionSpec);
    const resolved = resolveOne(key, optionSpec, raw[key], authority, specialistId);
    values[key] = resolved.value;
    policies[key] = {
      ...resolved.policy,
      effective: Array.isArray(resolved.value) ? [...resolved.value] : resolved.value
    };
    if (resolved.userValue !== undefined && authority !== "author") {
      userValues[key] = resolved.userValue;
    }
    diagnostics.push(...resolved.diagnostics);
  }
  return { mode, values, policies, userValues, diagnostics };
}

/**
 * Type-only coercion for a Planner value. Range and membership are enforced by
 * clamping afterwards, so an out-of-range request narrows to the boundary that
 * applies instead of being discarded as invalid.
 */
function normalizePlannerValue(
  spec: SpecialistOptionSpec,
  value: unknown
): SpecialistOptionValue | undefined {
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    // Clamping is stated in whole units for integer options, so round toward the
    // boundary the Planner asked for rather than rejecting the request.
    return spec.integer === false ? value : Math.floor(value);
  }
  if (spec.type === "string-list") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
    return [...value] as string[];
  }
  return normalizeOptionValue(spec, value);
}

/**
 * Applies Planner-provided option values for one Task. Only `planner` authority
 * options accept a value, and every accepted value is clamped into the effective
 * boundary, so a Planner mistake can never exceed what the author allowed.
 */
export function resolveTaskSpecialistOptions(
  policies: SpecialistOptionPolicyMap,
  plannerValues: unknown
): { values: SpecialistOptionValues; diagnostics: SpecialistRegistryDiagnostic[] } {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const values: SpecialistOptionValues = {};
  const raw: Record<string, unknown> = plannerValues && typeof plannerValues === "object" && !Array.isArray(plannerValues)
    ? plannerValues as Record<string, unknown>
    : {};
  for (const key of Object.keys(raw)) {
    if (!(key in policies)) {
      diagnostics.push(diagnostic(
        "specialist_option_unknown",
        `Task requested unknown Specialist option "${key}"`
      ));
    }
  }
  for (const [key, policy] of Object.entries(policies)) {
    const spec = policy.spec;
    const effective = policy.effective ?? policy.authorDefault ?? emptyOptionValue(spec);
    if (policy.authority !== "planner") {
      if (raw[key] !== undefined) {
        diagnostics.push(diagnostic(
          "specialist_option_not_planner_tunable",
          `Specialist option "${key}" is ${policy.authority}-owned and cannot be set per Task`
        ));
      }
      values[key] = Array.isArray(effective) ? [...effective] : effective;
      continue;
    }
    const requested = raw[key] === undefined ? undefined : normalizePlannerValue(spec, raw[key]);
    if (raw[key] !== undefined && requested === undefined) {
      diagnostics.push(diagnostic(
        "specialist_option_invalid",
        `Task provided an invalid value for Specialist option "${key}" (${describeOptionConstraint(spec)}); the resolved default applies`
      ));
    }
    if (spec.type === "number") {
      const bounds = policy.bounds ?? {};
      const candidate = typeof requested === "number" ? requested : (typeof effective === "number" ? effective : (bounds.minimum ?? 0));
      const clamped = clampNumberToBounds(candidate, bounds, spec);
      if (typeof requested === "number" && clamped !== requested) {
        diagnostics.push(diagnostic(
          "specialist_option_clamped",
          `Specialist option "${key}" value ${requested} was clamped to ${clamped} by the effective boundary`
        ));
      }
      values[key] = clamped;
      continue;
    }
    const allowed = policy.bounds?.allowed;
    if (spec.type === "string-list") {
      const fallback = Array.isArray(effective) ? effective : (allowed ?? []);
      const candidate = Array.isArray(requested) ? requested : fallback;
      const narrowed = clampStringListToBounds(candidate, allowed, spec);
      const resolvedList = narrowed.length > 0 ? narrowed : [...fallback];
      if (Array.isArray(requested) && !valuesEqual(resolvedList, requested)) {
        diagnostics.push(diagnostic(
          "specialist_option_clamped",
          `Specialist option "${key}" selection was narrowed to the effective boundary`
        ));
      }
      values[key] = resolvedList;
      continue;
    }
    values[key] = Array.isArray(effective) ? [...effective] : effective;
  }
  return { values, diagnostics };
}

export function valuesEqual(
  left: SpecialistOptionValue | undefined,
  right: SpecialistOptionValue | undefined
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  }
  return left === right;
}

/**
 * Planner-facing projection: only `planner` authority options, reduced to the
 * effective boundary. Returns undefined when nothing is planner-tunable so the
 * catalog entry stays compact.
 */
export function plannerTunableOptions(
  policies: SpecialistOptionPolicyMap
): SpecialistPlannerTunableOption[] | undefined {
  const entries: SpecialistPlannerTunableOption[] = [];
  for (const [key, policy] of Object.entries(policies)) {
    if (policy.authority !== "planner") continue;
    const spec = policy.spec;
    if (spec.type === "number") {
      entries.push({
        key,
        type: "number",
        title: spec.title,
        ...(spec.description ? { description: spec.description } : {}),
        ...(policy.bounds?.minimum !== undefined ? { minimum: policy.bounds.minimum } : {}),
        ...(policy.bounds?.maximum !== undefined ? { maximum: policy.bounds.maximum } : {}),
        ...(policy.userValue !== undefined ? { current: policy.userValue } : {}),
        hint: `Pick an integer in [${policy.bounds?.minimum ?? 0}, ${policy.bounds?.maximum ?? "unbounded"}]; values outside are clamped.`
      });
      continue;
    }
    if (spec.type === "string-list") {
      const allowed = policy.bounds?.allowed ?? [];
      entries.push({
        key,
        type: "string-list",
        title: spec.title,
        ...(spec.description ? { description: spec.description } : {}),
        allowed,
        ...(policy.userValue !== undefined ? { current: policy.userValue } : {}),
        hint: "Pick one or more values from allowed; anything else is dropped."
      });
    }
  }
  return entries.length > 0 ? entries : undefined;
}
