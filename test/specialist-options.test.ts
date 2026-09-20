import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveOptionAuthority,
  plannerTunableOptions,
  resolveSpecialistOptions,
  resolveTaskSpecialistOptions
} from "../src/specialists/options.js";
import { defineSpecialist, validateSpecialistDefinition } from "../src/specialists/sdk.js";
import { isPlannerTunable, type SpecialistAgentDefinition, type SpecialistOptionSpec } from "../src/specialists/types.js";

const numberSpec: SpecialistOptionSpec = {
  type: "number",
  title: "Threads",
  default: 4,
  minimum: 1,
  maximum: 8,
  integer: true
};

const unboundedNumberSpec: SpecialistOptionSpec = { type: "number", title: "Free", default: 3 };
const booleanSpec: SpecialistOptionSpec = { type: "boolean", title: "Flag", default: true };
const textSpec: SpecialistOptionSpec = { type: "text", title: "Material", default: "", authority: "user" };
const listSpec: SpecialistOptionSpec = {
  type: "string-list",
  title: "Protocols",
  default: ["http", "https", "ssh"]
};

function definition(options: Record<string, SpecialistOptionSpec>, optionsMode?: "planner" | "user"): Pick<SpecialistAgentDefinition, "id" | "options" | "optionsMode"> {
  return { id: "fixture", options, ...(optionsMode ? { optionsMode } : {}) };
}

test("isPlannerTunable requires an author-declared boundary", () => {
  assert.equal(isPlannerTunable(numberSpec), true);
  assert.equal(isPlannerTunable(unboundedNumberSpec), false);
  assert.equal(isPlannerTunable(listSpec), true);
  assert.equal(isPlannerTunable({ type: "string-list", title: "Empty" }), false);
  assert.equal(isPlannerTunable(booleanSpec), false);
  assert.equal(isPlannerTunable(textSpec), false);
});

test("effectiveOptionAuthority tightens by type and honours absolute declarations", () => {
  // No override: the Agent mode decides for tunable options, and everything the
  // Planner cannot tune falls back to the fail-safe posture.
  assert.equal(effectiveOptionAuthority("planner", undefined, numberSpec), "planner");
  assert.equal(effectiveOptionAuthority("planner", undefined, unboundedNumberSpec), "author");
  assert.equal(effectiveOptionAuthority("planner", undefined, booleanSpec), "author");
  assert.equal(effectiveOptionAuthority("user", undefined, numberSpec), "user");
  assert.equal(effectiveOptionAuthority("user", undefined, booleanSpec), "user");

  // Explicit author declarations are absolute in both directions of the switch.
  const locked: SpecialistOptionSpec = { ...numberSpec, authority: "author" };
  assert.equal(effectiveOptionAuthority("planner", "author", locked), "author");
  assert.equal(effectiveOptionAuthority("user", "author", locked), "author");

  // An explicit hand-off survives the mode switch.
  assert.equal(effectiveOptionAuthority("planner", "user", numberSpec), "user");
  // Planner authority on a type that has no boundary semantics degrades to a lock.
  assert.equal(effectiveOptionAuthority("user", "planner", booleanSpec), "author");
});

test("defineSpecialist rejects option authority combinations the UI cannot render honestly", () => {
  const base = {
    id: "authority-fixture",
    name: "Authority fixture",
    description: "fixture",
    prompt: { mode: "extend" as const, content: "" },
    budget: { defaultMaxTurns: 4, maxTurnsCeiling: 8, epochTurnSlice: 4, epochTimeShare: 0.2 }
  };
  const plannerBoolean = validateSpecialistDefinition({
    ...base,
    options: { flag: { type: "boolean", title: "Flag", authority: "planner" } }
  });
  assert.equal(plannerBoolean.some((entry) => /cannot use authority "planner"/.test(entry.message)), true);

  const plannerWithoutMaximum = validateSpecialistDefinition({
    ...base,
    options: { threads: { type: "number", title: "Threads", authority: "planner" } }
  });
  assert.equal(plannerWithoutMaximum.some((entry) => /cannot use authority "planner"/.test(entry.message)), true);

  const badMode = validateSpecialistDefinition({ ...base, optionsMode: "sideways" });
  assert.equal(badMode.some((entry) => /optionsMode/.test(entry.message)), true);

  const badAuthority = validateSpecialistDefinition({
    ...base,
    options: { threads: { type: "number", title: "Threads", authority: "root" } }
  });
  assert.equal(badAuthority.some((entry) => /authority must be one of/.test(entry.message)), true);

  // A well-formed planner-tunable number is accepted.
  assert.deepEqual(
    validateSpecialistDefinition({
      ...base,
      optionsMode: "planner",
      options: { threads: { type: "number", title: "Threads", maximum: 8, minimum: 1, default: 4 } }
    }),
    []
  );
  assert.equal(defineSpecialist({
    ...base,
    options: { material: { type: "text", title: "Material", authority: "user" } }
  }).id, "authority-fixture");
});

test("resolveSpecialistOptions pins author-owned options and rejects operator writes", () => {
  const resolved = resolveSpecialistOptions(
    definition({ stopOnLockout: { ...booleanSpec, authority: "author" } }),
    { stopOnLockout: false }
  );
  assert.equal(resolved.values.stopOnLockout, true);
  assert.equal(resolved.policies.stopOnLockout?.authority, "author");
  assert.equal(resolved.diagnostics.some((entry) => entry.code === "specialist_option_not_editable"), true);
  // A pinned option is never persisted as an operator value.
  assert.deepEqual(resolved.userValues, {});
});

test("resolveSpecialistOptions interprets an operator number as a boundary in planner mode", () => {
  const resolved = resolveSpecialistOptions(definition({ threads: numberSpec }), { threads: 2 });
  assert.equal(resolved.mode, "planner");
  assert.equal(resolved.values.threads, 2);
  assert.equal(resolved.policies.threads?.bounds?.maximum, 2);
  assert.equal(resolved.policies.threads?.bounds?.minimum, 1);
  assert.deepEqual(resolved.userValues, { threads: 2 });

  // A boundary below the author minimum is refused, not silently widened.
  const belowMinimum = resolveSpecialistOptions(definition({ threads: numberSpec }), { threads: 0 });
  assert.equal(belowMinimum.diagnostics.some((entry) => entry.code === "specialist_option_invalid"), true);

  // The author default still clamps down to the operator boundary.
  const tight = resolveSpecialistOptions(definition({ threads: numberSpec }), { threads: 1 });
  assert.equal(tight.values.threads, 1);
});

test("resolveSpecialistOptions narrows a string-list to the authorized superset", () => {
  const resolved = resolveSpecialistOptions(definition({ protocols: listSpec }), { protocols: ["ssh"] });
  assert.deepEqual(resolved.values.protocols, ["ssh"]);
  assert.deepEqual(resolved.policies.protocols?.bounds?.allowed, ["ssh"]);

  const disjoint = resolveSpecialistOptions(definition({ protocols: listSpec }), { protocols: ["rdp"] });
  assert.deepEqual(disjoint.values.protocols, ["http", "https", "ssh"]);
  assert.equal(disjoint.diagnostics.some((entry) => entry.code === "specialist_option_bound_excludes_all"), true);
});

test("resolveSpecialistOptions uses the operator value directly for user-owned options", () => {
  const resolved = resolveSpecialistOptions(definition({ material: textSpec }), { material: "POST /login" });
  assert.equal(resolved.values.material, "POST /login");
  assert.equal(resolved.policies.material?.authority, "user");
  assert.deepEqual(resolved.userValues, { material: "POST /login" });

  const unknown = resolveSpecialistOptions(definition({ material: textSpec }), { ghost: "x" });
  assert.equal(unknown.diagnostics.some((entry) => entry.code === "specialist_option_unknown"), true);
  assert.deepEqual(unknown.userValues, {});
});

test("resolveSpecialistOptions reports unknown keys and honours the operator mode", () => {
  const userMode = resolveSpecialistOptions(definition({ threads: numberSpec }, "user"), { threads: 6 });
  assert.equal(userMode.mode, "user");
  assert.equal(userMode.policies.threads?.authority, "user");
  assert.equal(userMode.values.threads, 6);
  // A stored mode wins over the author default.
  assert.equal(resolveSpecialistOptions(definition({ threads: numberSpec }, "planner"), { threads: 6 }, "user").mode, "user");
  // An invalid stored mode falls back to the author default.
  assert.equal(resolveSpecialistOptions(definition({ threads: numberSpec }, "user"), { threads: 6 }, "sideways").mode, "user");
});

test("resolveTaskSpecialistOptions clamps Task values into the effective boundary", () => {
  const resolved = resolveSpecialistOptions(definition({ threads: numberSpec }), { threads: 2 });
  const withinBounds = resolveTaskSpecialistOptions(resolved.policies, { threads: 2 });
  assert.equal(withinBounds.values.threads, 2);
  assert.deepEqual(withinBounds.diagnostics, []);

  // Above the operator ceiling: clamped, and the clamp is reported.
  const aboveCeiling = resolveTaskSpecialistOptions(resolved.policies, { threads: 8 });
  assert.equal(aboveCeiling.values.threads, 2);
  assert.equal(aboveCeiling.diagnostics.some((entry) => entry.code === "specialist_option_clamped"), true);

  // The author maximum is unreachable once the operator narrowed it.
  const noCeiling = resolveTaskSpecialistOptions(
    resolveSpecialistOptions(definition({ threads: numberSpec }), undefined).policies,
    { threads: 99 }
  );
  assert.equal(noCeiling.values.threads, 8);
  assert.equal(noCeiling.diagnostics.some((entry) => entry.code === "specialist_option_clamped"), true);

  // Omitting the key keeps the resolved default.
  assert.equal(resolveTaskSpecialistOptions(resolved.policies, {}).values.threads, 2);
  // An invalid value falls back instead of being applied.
  const invalid = resolveTaskSpecialistOptions(resolved.policies, { threads: "many" });
  assert.equal(invalid.values.threads, 2);
  assert.equal(invalid.diagnostics.some((entry) => entry.code === "specialist_option_invalid"), true);
});

test("resolveTaskSpecialistOptions refuses to set options the Planner does not own", () => {
  const resolved = resolveSpecialistOptions(
    definition({
      threads: numberSpec,
      material: textSpec,
      stopOnLockout: { ...booleanSpec, authority: "author" }
    }),
    { material: "operator material" }
  );
  const applied = resolveTaskSpecialistOptions(resolved.policies, {
    material: "planner material",
    stopOnLockout: false,
    ghost: 1
  });
  assert.equal(applied.values.material, "operator material");
  assert.equal(applied.values.stopOnLockout, true);
  const codes = applied.diagnostics.map((entry) => entry.code);
  assert.equal(codes.filter((code) => code === "specialist_option_not_planner_tunable").length, 2);
  assert.equal(codes.includes("specialist_option_unknown"), true);
});

test("resolveTaskSpecialistOptions narrows a Planner selection to the allowed set", () => {
  const resolved = resolveSpecialistOptions(definition({ protocols: listSpec }), { protocols: ["http", "ssh"] });
  const applied = resolveTaskSpecialistOptions(resolved.policies, { protocols: ["ssh", "rdp"] });
  assert.deepEqual(applied.values.protocols, ["ssh"]);
  assert.equal(applied.diagnostics.some((entry) => entry.code === "specialist_option_clamped"), true);
  // An entirely disallowed selection falls back to the effective set.
  const disallowed = resolveTaskSpecialistOptions(resolved.policies, { protocols: ["rdp"] });
  assert.deepEqual(disallowed.values.protocols, ["http", "ssh"]);
});

test("plannerTunableOptions publishes only Planner-owned options", () => {
  const resolved = resolveSpecialistOptions(
    definition({
      threads: numberSpec,
      material: textSpec,
      stopOnLockout: { ...booleanSpec, authority: "author" },
      protocols: listSpec
    }),
    { threads: 3 }
  );
  const tunable = plannerTunableOptions(resolved.policies)!;
  assert.deepEqual(tunable.map((option) => option.key).sort(), ["protocols", "threads"]);
  const threads = tunable.find((option) => option.key === "threads")!;
  assert.equal(threads.maximum, 3);
  assert.equal(threads.minimum, 1);
  assert.equal(threads.current, 3);
  const protocols = tunable.find((option) => option.key === "protocols")!;
  assert.deepEqual(protocols.allowed, ["http", "https", "ssh"]);

  // Nothing Planner-tunable means no catalog section at all.
  assert.equal(plannerTunableOptions(resolveSpecialistOptions(definition({ material: textSpec }), {}).policies), undefined);
});
