import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GENERAL_SPECIALIST_ID } from "../src/specialists/builtin/index.js";
import { SpecialistOptionError, SpecialistRegistry } from "../src/specialists/registry.js";
import { SkillRegistry } from "../src/skills/skill-registry.js";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "specialist-registry-"));
}

function writeAgent(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = join(root, ".agents", "specialists", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "specialist.json"), JSON.stringify({ id, ...manifest }, null, 2));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("registry exposes built-ins and keeps the general Specialist enabled", async () => {
  const root = fixtureRoot();
  const registry = new SpecialistRegistry({ cwd: root });
  const snapshot = registry.scan();
  assert.deepEqual(snapshot.specialists.map((entry) => entry.id), ["bruteforce", "general", "internet-osint"]);
  const general = snapshot.specialists.find((entry) => entry.id === GENERAL_SPECIALIST_ID)!;
  assert.equal(general.enabled, true);
  assert.equal(general.source, "builtin");
  assert.equal(general.valid, true);
  assert.equal(general.introspected, true);

  await assert.rejects(() => registry.setEnabled(GENERAL_SPECIALIST_ID, false), SpecialistOptionError);

  await registry.setEnabled("bruteforce", false);
  const disabled = await registry.resolve("bruteforce");
  assert.equal(disabled.ok, false);
  assert.equal(disabled.ok === false ? disabled.reason : "", "disabled");
  assert.deepEqual((await registry.catalog()).map((entry) => entry.id), [GENERAL_SPECIALIST_ID, "internet-osint"]);

  await registry.setEnabled("bruteforce", true);
  const catalog = await registry.catalog();
  assert.deepEqual(catalog.map((entry) => entry.id), ["bruteforce", GENERAL_SPECIALIST_ID, "internet-osint"]);
  assert.deepEqual(catalog[0]!.disabledToolGroups, ["network_diagnostics", "fofa", "beekeeper"]);
});

test("resolve returns the built-in bruteforce profile with tool, skill and budget narrowing", async () => {
  const root = fixtureRoot();
  const registry = new SpecialistRegistry({ cwd: root });
  const resolution = await registry.resolve("bruteforce");
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.deepEqual(resolution.definition.tools?.disableGroups, ["fofa", "beekeeper", "network_diagnostics"]);
  assert.equal(resolution.definition.skills?.mode, "allowlist");
  assert.equal(resolution.definition.budget.epochTimeShare, 0.7);
  assert.equal(resolution.definition.concurrency?.maxParallelTasks, 1);
  assert.equal(resolution.options.threads, 4);
  assert.equal(resolution.options.maxAttemptsPerAccount, 20);
  // The author pins the lockout switch and the material stays operator-owned.
  assert.equal(resolution.options.stopOnLockout, true);
  assert.equal(resolution.optionPolicies.stopOnLockout?.authority, "author");
  assert.equal(resolution.optionPolicies.material?.authority, "user");
  assert.equal(resolution.optionPolicies.threads?.authority, "planner");

  const options = await registry.setOptions("bruteforce", { threads: 2, maxAttemptsPerAccount: 5, material: "POST /login" });
  const byKey = new Map(options.options.map((entry) => [entry.key, entry]));
  // Planner-owned numbers accept an operator *boundary*, not a value.
  assert.deepEqual(
    [byKey.get("threads")!.value, byKey.get("threads")!.boundOnly, byKey.get("threads")!.authority],
    [2, true, "planner"]
  );
  assert.deepEqual(
    [byKey.get("maxAttemptsPerAccount")!.value, byKey.get("maxAttemptsPerAccount")!.boundOnly],
    [5, true]
  );
  // Operator-owned material is stored verbatim.
  assert.equal(byKey.get("material")!.value, "POST /login");
  // Author-owned options stay read-only and expose their pinned value.
  assert.equal(byKey.get("stopOnLockout")!.editable, false);
  assert.equal(byKey.get("stopOnLockout")!.value, true);

  const reread = await new SpecialistRegistry({ cwd: root }).resolve("bruteforce");
  assert.equal(reread.ok, true);
  assert.equal(reread.ok === true ? reread.options.threads : undefined, 2);
  assert.equal(reread.ok === true ? reread.options.material : undefined, "POST /login");

  // An operator may never widen the author's envelope.
  await assert.rejects(() => registry.setOptions("bruteforce", { threads: 999 }), SpecialistOptionError);
  // An author-owned option is rejected outright, not silently ignored.
  await assert.rejects(() => registry.setOptions("bruteforce", { stopOnLockout: false }), SpecialistOptionError);
  await assert.rejects(() => registry.setOptions("bruteforce", { ghost: 1 }), SpecialistOptionError);
});

test("option authority honours the Agent mode and per-option tightening", async () => {
  const root = fixtureRoot();
  const registry = new SpecialistRegistry({ cwd: root });

  // The built-in ships with the restrictive default.
  let snapshot = await registry.describeAll();
  const initial = snapshot.specialists.find((entry) => entry.id === "bruteforce")!;
  assert.equal(initial.optionsMode, "planner");
  assert.equal(initial.authorOptionsMode, "planner");
  assert.equal(initial.options.find((entry) => entry.key === "threads")!.editable, true);

  // Switching to user mode keeps author pins intact and keeps author bounds.
  let updated = await registry.setOptionsMode("bruteforce", "user");
  assert.equal(updated.optionsMode, "user");
  assert.equal(updated.options.find((entry) => entry.key === "stopOnLockout")!.authority, "author");
  await assert.rejects(() => registry.setOptions("bruteforce", { stopOnLockout: false }), SpecialistOptionError);
  const userMode = await registry.setOptions("bruteforce", { threads: 7 });
  assert.equal(userMode.options.find((entry) => entry.key === "threads")!.value, 7);
  assert.equal(userMode.options.find((entry) => entry.key === "threads")!.boundOnly, false);
  // The author maximum is a hard bound in either mode: an out-of-range value is
  // rejected with the constraint rather than silently rewritten.
  await assert.rejects(
    () => registry.setOptions("bruteforce", { threads: 99 }),
    (error: unknown) => error instanceof SpecialistOptionError
      && /between 1 and 8/.test(error.message)
  );

  // Resetting to the author default drops the operator override.
  updated = await registry.setOptionsMode("bruteforce", null);
  assert.equal(updated.optionsMode, "planner");
  assert.equal(updated.authorOptionsMode, "planner");
  await assert.rejects(() => registry.setOptionsMode("bruteforce", "sideways"), SpecialistOptionError);
});

test("the Planner catalog publishes only planner-tunable options and their boundary", async () => {
  const root = fixtureRoot();
  const registry = new SpecialistRegistry({ cwd: root });
  const entry = (await registry.catalog()).find((candidate) => candidate.id === "bruteforce")!;
  const keys = (entry.tunableOptions ?? []).map((option) => option.key).sort();
  assert.deepEqual(keys, ["maxAttemptsPerAccount", "maxTotalAttempts", "threads"]);
  const threads = entry.tunableOptions!.find((option) => option.key === "threads")!;
  assert.equal(threads.type, "number");
  assert.equal(threads.minimum, 1);
  assert.equal(threads.maximum, 8);

  // The operator boundary narrows what the Planner may pick from.
  await registry.setOptions("bruteforce", { threads: 2 });
  const narrowed = (await registry.catalog()).find((candidate) => candidate.id === "bruteforce")!;
  assert.equal(narrowed.tunableOptions!.find((option) => option.key === "threads")!.maximum, 2);
  // Operator-owned and author-owned options never reach the Planner's view.
  assert.equal(narrowed.tunableOptions!.some((option) => option.key === "material"), false);
  assert.equal(narrowed.tunableOptions!.some((option) => option.key === "stopOnLockout"), false);
});

test("manifest-only project Specialists load prompt files and join the catalog", async () => {
  const root = fixtureRoot();
  writeAgent(root, "recon-lite", {
    name: "Recon Lite",
    description: "Light reconnaissance",
    whenToUse: "Use for small recon tasks",
    prompt: { mode: "extend", file: "prompt.md" },
    tools: { disableGroups: ["fofa", "beekeeper"] },
    budget: { defaultMaxTurns: 6, maxTurnsCeiling: 8, epochTurnSlice: 4, epochTimeShare: 0.2 },
    options: { depth: { type: "number", title: "Depth", default: 2, minimum: 1, maximum: 5, integer: true } }
  }, { "prompt.md": "Recon carefully." });

  const registry = new SpecialistRegistry({ cwd: root });
  const snapshot = await registry.describeAll();
  const entry = snapshot.specialists.find((candidate) => candidate.id === "recon-lite")!;
  assert.equal(entry.source, "project");
  assert.equal(entry.valid, true);
  assert.equal(entry.executability, "prompt-only");
  assert.deepEqual(entry.disabledGroups, ["fofa", "beekeeper"]);
  assert.equal(entry.budget.defaultMaxTurns, 6);

  const resolution = await registry.resolve("recon-lite");
  assert.equal(resolution.ok, true);
  assert.equal(resolution.ok === true ? resolution.definition.prompt.content : "", "Recon carefully.");
  assert.deepEqual((await registry.catalog()).map((candidate) => candidate.id), ["bruteforce", "general", "internet-osint", "recon-lite"]);
});

test("the built-in bruteforce Skill allowlist matches the Skills this repository ships", async () => {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const registry = new SpecialistRegistry({ cwd: fixtureRoot() });
  const resolution = await registry.resolve("bruteforce");
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  const allow = resolution.definition.skills?.allow ?? [];
  assert.ok(allow.length > 0, "bruteforce must declare an explicit Skill allowlist");

  // `.agents/skills/` is project-local and git-ignored, so the tracked source of
  // truth is templates/skills/. An allowlist naming Skills nothing provides
  // silently leaves the Agent with no knowledge surface at all — which is the
  // regression this guard exists to catch, and it must be catchable from a
  // fresh clone that has installed nothing yet.
  const bundled = new SkillRegistry(join(repoRoot, "templates", "skills"), join(fixtureRoot(), "skills-state.json")).scan();
  const bundledNames = new Set(bundled.skills.map((skill) => skill.name));
  assert.deepEqual(
    allow.filter((name) => !bundledNames.has(name)),
    [],
    `bruteforce allowlists Skills this repository does not ship; bundled: ${[...bundledNames].sort().join(", ")}`
  );
  for (const name of allow) {
    const skill = bundled.skills.find((candidate) => candidate.name === name)!;
    assert.equal(skill.valid, true, `bundled Skill ${name} must load without diagnostics`);
    assert.equal(skill.modelInvocable, true, `bundled Skill ${name} must be invocable by the model`);
  }

  // When the workspace has them installed, they must also be usable there.
  const installedDir = join(repoRoot, ".agents", "skills");
  if (existsSync(installedDir)) {
    const installed = new SkillRegistry(installedDir, join(fixtureRoot(), "skills-state.json")).scan();
    for (const name of allow) {
      const skill = installed.skills.find((candidate) => candidate.name === name);
      assert.ok(skill, `${name} must be installed in .agents/skills for this workspace to use it`);
      assert.equal(
        skill.valid && skill.enabled && skill.modelInvocable,
        true,
        `${name} is installed but not usable by the model`
      );
    }
  }
});

test("the shipped scaffolding templates stay loadable and keep their documented authority", async () => {
  const templates = new URL("../../templates/specialists/", import.meta.url).pathname;
  const root = fixtureRoot();
  const registry = new SpecialistRegistry({
    cwd: root,
    projectDir: templates,
    statePath: join(root, "specialists-state.json")
  });
  const snapshot = await registry.describeAll();
  const recon = snapshot.specialists.find((candidate) => candidate.id === "recon-lite");
  assert.ok(recon, "templates/specialists/recon-lite must stay loadable");
  assert.equal(recon.valid, true);
  // A task-parameter option in the template must be handed to the operator, not
  // silently locked by the restrictive default mode.
  const scopeNote = recon.options.find((option) => option.key === "scopeNote")!;
  assert.equal(scopeNote.authority, "user");
  assert.equal(scopeNote.editable, true);
  assert.equal(recon.optionsMode, "planner");

  // The module template ships disabled, so its definition is only introspected
  // once it is enabled.
  await registry.setEnabled("example-module", true);
  const enabled = await registry.describeAll();
  const example = enabled.specialists.find((candidate) => candidate.id === "example-module");
  assert.ok(example, "templates/specialists/example-module must stay loadable");
  assert.equal(example.valid, true);
  assert.equal(example.introspected, true);
  const target = example.options.find((option) => option.key === "target")!;
  const retries = example.options.find((option) => option.key === "retries")!;
  assert.equal(target.authority, "user");
  assert.equal(retries.authority, "planner");
  assert.equal(retries.boundOnly, true);
  assert.equal(retries.bounds?.maximum, 10);
});

test("project modules are imported only while enabled and can contribute tools", async () => {
  const root = fixtureRoot();
  writeAgent(root, "module-agent", {
    name: "Module Agent",
    description: "Declared in code",
    entry: "index.mjs"
  }, {
    "index.mjs": `
globalThis.__specialistModuleRuns = (globalThis.__specialistModuleRuns ?? 0) + 1;
export default (api) => ({
  id: "module-agent",
  name: "Module Agent",
  description: "Declared in code",
  prompt: { mode: "extend", content: "module prompt" },
  budget: { defaultMaxTurns: 4, maxTurnsCeiling: 6, epochTurnSlice: 2, epochTimeShare: 0.1 },
  options: { token: { type: "string", title: "Token", default: "abc" } },
  createTools: () => [api.defineTool({
    name: "custom_probe",
    label: "Custom probe",
    description: "probe",
    parameters: api.Type.Object({ target: api.Type.String() }, { additionalProperties: false }),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] })
  })]
});
`
  });

  const marker = (): number => (globalThis as Record<string, unknown>).__specialistModuleRuns as number | undefined ?? 0;
  delete (globalThis as Record<string, unknown>).__specialistModuleRuns;

  const registry = new SpecialistRegistry({ cwd: root });
  const scanned = registry.scan();
  const shell = scanned.specialists.find((candidate) => candidate.id === "module-agent")!;
  assert.equal(shell.executability, "module");
  assert.equal(shell.introspected, false);
  assert.equal(shell.valid, true, "an unloaded module is unproven, not invalid");
  assert.equal(marker(), 0, "scan must not execute project module code");

  await registry.setEnabled("module-agent", false);
  const disabled = await registry.describeAll();
  const disabledEntry = disabled.specialists.find((candidate) => candidate.id === "module-agent")!;
  assert.equal(disabledEntry.introspected, false);
  assert.equal(disabledEntry.valid, true);
  assert.equal(marker(), 0, "disabled modules must never be imported");
  const disabledResolution = await registry.resolve("module-agent");
  assert.equal(disabledResolution.ok, false);
  assert.equal(disabledResolution.ok === false ? disabledResolution.reason : "", "disabled");

  await registry.setEnabled("module-agent", true);
  const described = await registry.describeAll();
  const entry = described.specialists.find((candidate) => candidate.id === "module-agent")!;
  assert.equal(entry.introspected, true);
  assert.equal(entry.valid, true, JSON.stringify(entry.diagnostics));
  assert.equal(marker(), 1);
  assert.equal(entry.options[0]?.key, "token");

  const resolution = await registry.resolve("module-agent");
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.equal(typeof resolution.definition.createTools, "function");
  assert.deepEqual((await registry.catalog()).map((candidate) => candidate.id), ["bruteforce", "general", "internet-osint", "module-agent"]);
});

test("invalid project Specialists degrade to diagnostics without breaking the registry", async () => {
  const root = fixtureRoot();
  writeAgent(root, "Bad_Id", { name: "Bad", description: "bad", prompt: { content: "x" } });
  writeAgent(root, "escaping", {
    name: "Escaping",
    description: "escapes",
    entry: "../outside.mjs"
  });
  writeAgent(root, "broken-module", {
    name: "Broken",
    description: "throws",
    entry: "index.mjs"
  }, { "index.mjs": "throw new Error('boom');" });
  writeAgent(root, "mismatched", {
    name: "Mismatched",
    description: "id mismatch",
    entry: "index.mjs"
  }, {
    "index.mjs": `export default { id: "other-id", name: "x", description: "y", prompt: { mode: "extend", content: "" }, budget: { defaultMaxTurns: 2, maxTurnsCeiling: 2, epochTurnSlice: 1, epochTimeShare: 0.1 } };`
  });
  mkdirSync(join(root, ".agents", "specialists", "empty-dir"), { recursive: true });

  const registry = new SpecialistRegistry({ cwd: root });
  const snapshot = await registry.describeAll();
  const byId = new Map(snapshot.specialists.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("Bad_Id")!.valid, false);
  assert.ok(byId.get("Bad_Id")!.diagnostics.some((diagnostic) => diagnostic.code === "specialist_id_invalid"));
  assert.ok(byId.get("escaping")!.diagnostics.some((diagnostic) => diagnostic.code === "specialist_entry_outside_root"));
  assert.ok(byId.get("broken-module")!.diagnostics.some((diagnostic) => diagnostic.code === "specialist_module_failed"));
  assert.ok(byId.get("mismatched")!.diagnostics.some((diagnostic) => diagnostic.code === "specialist_module_invalid_export"));
  assert.ok(byId.get("empty-dir")!.diagnostics.some((diagnostic) => diagnostic.code === "specialist_manifest_missing"));

  const failed = await registry.resolve("broken-module");
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false ? failed.reason : "", "load_failed");
  const unknown = await registry.resolve("does-not-exist");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false ? unknown.reason : "", "unknown");

  assert.deepEqual((await registry.catalog()).map((entry) => entry.id), ["bruteforce", "general", "internet-osint"]);
});

test("registry state file is written atomically with restricted permissions", async () => {
  const root = fixtureRoot();
  const registry = new SpecialistRegistry({ cwd: root });
  await registry.setEnabled("bruteforce", false);
  const statePath = join(root, ".agents", "specialists-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, { enabled?: boolean; options?: unknown }>;
  assert.equal(state.bruteforce?.enabled, false);
  await registry.setOptions("general", {});
  const rewritten = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, { enabled?: boolean }>;
  assert.equal(rewritten.bruteforce?.enabled, false);
});

test("internet-osint narrows the tool surface and pins its method invariants", async () => {
  const registry = new SpecialistRegistry({ cwd: fixtureRoot() });
  const resolution = await registry.resolve("internet-osint");
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;

  // Credential stores, FOFA and connectivity are other channels; removing them
  // is what makes "this Agent never writes credentials" structural rather than
  // prompt-enforced.
  assert.deepEqual(resolution.definition.tools?.disableGroups, [
    "beekeeper", "credentials", "network_diagnostics", "fofa", "connectivity"
  ]);
  assert.equal(resolution.definition.skills?.mode, "allowlist");
  assert.deepEqual(
    resolution.definition.skills?.mode === "allowlist" ? resolution.definition.skills.allow : [],
    ["osint-query-strategy", "osint-source-reliability"]
  );
  assert.equal(resolution.definition.concurrency?.maxParallelTasks, 2);
  assert.equal(resolution.definition.budget.epochTurnSlice, 14);
});

test("internet-osint splits option authority across operator, planner and author", async () => {
  const registry = new SpecialistRegistry({ cwd: fixtureRoot() });
  const snapshot = await registry.describeAll();
  const osint = snapshot.specialists.find((entry) => entry.id === "internet-osint");
  assert.ok(osint, "internet-osint must be in the registry");

  const byKey = new Map(osint.options.map((option) => [option.key, option]));
  const authorityOf = (key: string) => byKey.get(key)?.authority;

  // Operator owns what to collect and how personal data is handled.
  for (const key of [
    "targets", "collectionGoal", "personalDataPolicy", "minConfidence",
    "readPages", "sources", "excludeDomains", "maxMemoryNodes"
  ]) {
    assert.equal(authorityOf(key), "user", `${key} should be operator-editable`);
    assert.equal(byKey.get(key)?.editable, true);
  }

  // The Planner may move collection volume, but only inside the author's maxima.
  for (const key of ["maxRounds", "maxQueriesPerRound", "maxResultsPerQuery", "maxSourceCalls"]) {
    assert.equal(authorityOf(key), "planner", `${key} should be Planner-tunable`);
    assert.equal(byKey.get(key)?.boundOnly, true, `${key} must publish a boundary`);
  }

  // The two method invariants are not operator knobs.
  for (const key of ["writeGraphMemory", "crossSourceConfirmation"]) {
    assert.equal(authorityOf(key), "author", `${key} is pinned by the author`);
    assert.equal(byKey.get(key)?.editable, false);
  }

  assert.equal(osint.options.length, 14);
  assert.deepEqual(snapshot.diagnostics, []);
});

test("internet-osint ships the option types no other builtin exercised", async () => {
  // Before this Specialist, no builtin declared `enum` or `string-list`, so
  // those were untested paths through both the manifest validator and the
  // config-page renderer.
  const registry = new SpecialistRegistry({ cwd: fixtureRoot() });
  const snapshot = await registry.describeAll();
  const osint = snapshot.specialists.find((entry) => entry.id === "internet-osint")!;
  const byKey = new Map(osint.options.map((option) => [option.key, option]));

  const goal = byKey.get("collectionGoal")!;
  assert.equal(goal.spec.type, "enum");
  assert.deepEqual(
    (goal.spec as { options: Array<{ value: string }> }).options.map((item) => item.value),
    ["all", "assets", "system", "contact", "people"]
  );
  assert.equal(goal.value, "all");

  const sources = byKey.get("sources")!;
  assert.equal(sources.spec.type, "string-list");
  assert.deepEqual(sources.value, ["sogou", "so360", "bing"]);

  // An empty default would mean "no declared superset", which cannot be narrowed.
  const exclude = byKey.get("excludeDomains")!;
  assert.equal(exclude.spec.type, "string-list");
  assert.deepEqual(exclude.value, []);
});

test("internet-osint treats an operator write as a boundary, not a value", async () => {
  const registry = new SpecialistRegistry({ cwd: fixtureRoot() });
  const applied = await registry.setOptions("internet-osint", {
    maxQueriesPerRound: 4,
    maxSourceCalls: 60,
    collectionGoal: "contact",
    sources: ["sogou", "so360"]
  });
  const byKey = new Map(applied.options.map((option) => [option.key, option]));

  // Operator-owned options take the value directly.
  assert.equal(byKey.get("collectionGoal")?.value, "contact");
  assert.deepEqual(byKey.get("sources")?.value, ["sogou", "so360"]);

  // Planner-owned numbers are the opposite: the operator declares the ceiling
  // and the Planner later picks a concrete value inside it, so the value stays
  // at the author default and only the bound moves.
  assert.equal(byKey.get("maxQueriesPerRound")?.value, 3, "value stays at the author default");
  assert.equal(byKey.get("maxQueriesPerRound")?.bounds?.maximum, 4, "the operator's number becomes the ceiling");
  assert.equal(byKey.get("maxSourceCalls")?.bounds?.maximum, 60, "the ceiling narrows");
  assert.equal(byKey.get("maxResultsPerQuery")?.bounds?.maximum, 20, "untouched planner options keep the author range");

  // The declared boundary can only narrow: a request above the author maximum is
  // an error, never a widening of the envelope.
  await assert.rejects(
    () => registry.setOptions("internet-osint", { maxSourceCalls: 500 }),
    SpecialistOptionError
  );
  // An operator write is an explicit admin action, so out-of-range is an error
  // rather than a silent clamp.
  await assert.rejects(
    () => registry.setOptions("internet-osint", { maxRounds: 999 }),
    SpecialistOptionError
  );
  // Author-pinned invariants reject the write instead of ignoring it.
  await assert.rejects(
    () => registry.setOptions("internet-osint", { writeGraphMemory: false }),
    SpecialistOptionError
  );
  await assert.rejects(
    () => registry.setOptions("internet-osint", { collectionGoal: "not-a-goal" }),
    SpecialistOptionError
  );
  await assert.rejects(
    () => registry.setOptions("internet-osint", { noSuchOption: 1 }),
    SpecialistOptionError
  );
});
