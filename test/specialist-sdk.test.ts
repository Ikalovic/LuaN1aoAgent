import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSpecialistOptions,
  defineSpecialist,
  normalizeSpecialistOptions,
  SpecialistDefinitionError
} from "../src/specialists/sdk.js";
import { renderSpecialistSystemPrompt, SPECIALIST_RUNTIME_CONTRACT } from "../src/specialists/prompt.js";
import { applySpecialistToolPolicy, specialistToolGroupScope } from "../src/specialists/tools.js";
import { DEFAULT_SPECIALIST_BUDGET, type SpecialistToolBinding } from "../src/specialists/types.js";

function tool(name: string) {
  return { name, label: name, description: name, parameters: {}, execute: async () => ({ content: [] }) } as never;
}

function bindings(): SpecialistToolBinding[] {
  return [
    { group: "sandbox", tool: tool("bash") },
    { group: "sandbox", tool: tool("read") },
    { group: "research", tool: tool("web_search") },
    { group: "browser", tool: tool("browser_render") },
    { group: "credentials", tool: tool("credential_query") },
    { group: "submit", tool: tool("task_result_submit") }
  ];
}

const minimal = {
  id: "example-agent",
  name: "Example",
  description: "An example Specialist",
  prompt: { mode: "extend" as const, content: "Do the thing." },
  budget: { ...DEFAULT_SPECIALIST_BUDGET }
};

test("defineSpecialist accepts a minimal definition and rejects invalid ones", () => {
  assert.equal(defineSpecialist(minimal).id, "example-agent");

  assert.throws(() => defineSpecialist({ ...minimal, id: "Bad_Id" }), SpecialistDefinitionError);
  assert.throws(() => defineSpecialist({ ...minimal, name: "  " }), SpecialistDefinitionError);
  assert.throws(() => defineSpecialist({ ...minimal, description: "" }), SpecialistDefinitionError);
  assert.throws(
    () => defineSpecialist({ ...minimal, prompt: { mode: "replace" as const, content: 5 as unknown as string } }),
    SpecialistDefinitionError
  );
  assert.throws(
    () => defineSpecialist({
      ...minimal,
      budget: { defaultMaxTurns: 30, maxTurnsCeiling: 10, epochTurnSlice: 5, epochTimeShare: 0.5 }
    }),
    SpecialistDefinitionError
  );
  assert.throws(
    () => defineSpecialist({
      ...minimal,
      budget: { defaultMaxTurns: 4, maxTurnsCeiling: 8, epochTurnSlice: 4, epochTimeShare: 1.5 }
    }),
    SpecialistDefinitionError
  );
  assert.throws(
    () => defineSpecialist({ ...minimal, tools: { disableGroups: ["nope" as never] } }),
    SpecialistDefinitionError
  );
  assert.throws(
    () => defineSpecialist({ ...minimal, skills: { mode: "pinned" as const, pinned: [] } }),
    SpecialistDefinitionError
  );
  assert.throws(
    () => defineSpecialist({ ...minimal, skills: { mode: "allowlist" as const, allow: [] } }),
    SpecialistDefinitionError
  );
  assert.throws(
    () => defineSpecialist({ ...minimal, options: { bad: { type: "enum" as const, title: "x", options: [] } } }),
    SpecialistDefinitionError
  );
});

test("applySpecialistToolPolicy narrows tool groups but never drops the submit contract", () => {
  const disabled = applySpecialistToolPolicy(bindings(), { disableGroups: ["sandbox", "browser"] });
  assert.deepEqual(disabled.tools.map((entry) => entry.name), ["web_search", "credential_query", "task_result_submit"]);
  assert.deepEqual(disabled.removedToolNames, ["bash", "browser_render", "read"]);
  assert.deepEqual(disabled.disabledGroups, ["sandbox", "browser"]);
  assert.ok(disabled.enabledGroups.includes("submit"));

  const protectedGroup = applySpecialistToolPolicy(bindings(), { disableGroups: ["submit"] });
  assert.ok(protectedGroup.tools.some((entry) => entry.name === "task_result_submit"));
  assert.equal(protectedGroup.diagnostics[0]?.code, "specialist_tool_group_protected");

  const allowlisted = applySpecialistToolPolicy(bindings(), { allow: ["web_search", "bash"] });
  assert.deepEqual(allowlisted.tools.map((entry) => entry.name), ["bash", "web_search", "task_result_submit"]);

  const denied = applySpecialistToolPolicy(bindings(), { allow: ["bash"], deny: ["bash"] });
  assert.deepEqual(denied.tools.map((entry) => entry.name), ["task_result_submit"]);

  const unknownNames = applySpecialistToolPolicy(bindings(), { allow: ["ghost"], deny: ["phantom"] });
  assert.deepEqual(
    unknownNames.diagnostics.map((entry) => entry.code).sort(),
    ["specialist_tool_name_unknown", "specialist_tool_name_unknown"]
  );

  const denySubmit = applySpecialistToolPolicy(bindings(), { deny: ["task_result_submit"] });
  assert.ok(denySubmit.tools.some((entry) => entry.name === "task_result_submit"));
  assert.ok(denySubmit.diagnostics.some((entry) => entry.code === "specialist_tool_group_protected"));

  assert.deepEqual(applySpecialistToolPolicy(bindings(), undefined).tools.length, bindings().length);
});

test("specialistToolGroupScope reports the declared group scope", () => {
  const scope = specialistToolGroupScope({ disableGroups: ["fofa", "submit"], deny: ["credential_query"] });
  assert.deepEqual(scope.disabledGroups, ["fofa"]);
  assert.ok(scope.enabledGroups.includes("submit"));
  assert.deepEqual(scope.deny, ["credential_query"]);
});

test("renderSpecialistSystemPrompt composes the base prompt, options and runtime contract", () => {
  const definition = defineSpecialist({
    ...minimal,
    tools: { disableGroups: ["fofa"] },
    options: {
      threads: { type: "number", title: "Threads", default: 4 },
      target: { type: "string", title: "Target", default: "example.test" },
      verbose: { type: "boolean", title: "Verbose", default: false },
      flags: { type: "string-list", title: "Flags", default: ["a", "b"] }
    },
    prompt: {
      mode: "extend" as const,
      content: "threads={{options.threads}} target={{options.target}} verbose={{options.verbose}} flags={{options.flags}} missing={{options.nope}}"
    }
  });
  const rendered = renderSpecialistSystemPrompt({
    definition,
    options: { threads: 8, target: "10.0.0.5", verbose: true, flags: ["x"] },
    basePrompt: "BASE CONTRACT",
    enabledGroups: ["sandbox", "submit"],
    disabledGroups: ["fofa"]
  });
  assert.ok(rendered.systemPrompt.startsWith("BASE CONTRACT"));
  assert.ok(rendered.systemPrompt.includes("threads=8 target=10.0.0.5 verbose=true flags=x"));
  assert.ok(rendered.systemPrompt.includes("{{options.nope}}"));
  assert.ok(rendered.systemPrompt.includes(SPECIALIST_RUNTIME_CONTRACT));
  assert.ok(rendered.systemPrompt.includes("## 当前配置"));
  assert.deepEqual(rendered.diagnostics.map((entry) => entry.code), ["specialist_prompt_placeholder_unknown"]);
});

test("renderSpecialistSystemPrompt keeps the baseline prompt for a no-op Specialist", () => {
  const definition = defineSpecialist({ ...minimal, prompt: { mode: "extend" as const, content: "   " } });
  const rendered = renderSpecialistSystemPrompt({
    definition,
    options: {},
    basePrompt: "BASE CONTRACT",
    enabledGroups: ["sandbox"],
    disabledGroups: []
  });
  assert.equal(rendered.systemPrompt, "BASE CONTRACT");
  assert.deepEqual(rendered.diagnostics, []);

  const general = defineSpecialist({ ...minimal, id: "general" });
  assert.equal(
    renderSpecialistSystemPrompt({
      definition: { ...general, prompt: { mode: "extend", content: "" } },
      options: {},
      basePrompt: "BASE CONTRACT",
      enabledGroups: [],
      disabledGroups: []
    }).systemPrompt,
    "BASE CONTRACT"
  );
});

test("renderSpecialistSystemPrompt replaces the base prompt in replace mode", () => {
  const definition = defineSpecialist({
    ...minimal,
    prompt: { mode: "replace" as const, content: "ONLY THIS" }
  });
  const rendered = renderSpecialistSystemPrompt({
    definition,
    options: {},
    basePrompt: "BASE CONTRACT",
    enabledGroups: [],
    disabledGroups: []
  });
  assert.ok(!rendered.systemPrompt.includes("BASE CONTRACT"));
  assert.ok(rendered.systemPrompt.startsWith("ONLY THIS"));
  assert.ok(rendered.systemPrompt.includes(SPECIALIST_RUNTIME_CONTRACT));
});

test("normalizeSpecialistOptions merges defaults, rejects bad values and flags unknown keys", () => {
  const spec = {
    threads: { type: "number" as const, title: "Threads", default: 4, minimum: 1, maximum: 8, integer: true },
    mode: { type: "enum" as const, title: "Mode", options: [{ value: "fast", label: "Fast" }], default: "fast" },
    stop: { type: "boolean" as const, title: "Stop", default: true },
    hosts: { type: "string-list" as const, title: "Hosts", default: ["a"], maxItems: 2 },
    name: { type: "string" as const, title: "Name", pattern: "^[a-z]+$" }
  };
  assert.deepEqual(defaultSpecialistOptions(spec), { threads: 4, mode: "fast", stop: true, hosts: ["a"] });

  const merged = normalizeSpecialistOptions(spec, { threads: 6, hosts: ["x", "y"], ghost: 1 });
  assert.deepEqual(merged.values, { threads: 6, mode: "fast", stop: true, hosts: ["x", "y"] });
  assert.deepEqual(merged.diagnostics.map((entry) => entry.code), ["specialist_option_unknown"]);
  assert.deepEqual(merged.unknownKeys, ["ghost"]);

  const invalid = normalizeSpecialistOptions(spec, { threads: 99, mode: "slow", name: "ABC", hosts: ["a", "b", "c"], stop: 1 });
  assert.equal(invalid.diagnostics.filter((entry) => entry.code === "specialist_option_invalid").length, 5);
  assert.equal(invalid.values.threads, 4);
  assert.equal(invalid.values.mode, "fast");
  assert.equal(invalid.values.stop, true);
  assert.equal("name" in invalid.values, false);
});
