import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecurityAgentController, admitReadyTasks } from "../src/controller.js";
import { SpecialistRegistry } from "../src/specialists/registry.js";
import { GENERAL_SPECIALIST_ID } from "../src/specialists/builtin/index.js";
import type { RegisteredSpecialist, SpecialistAgentDefinition } from "../src/specialists/types.js";
import type { SkillRegistrySnapshot } from "../src/skills/skill-registry.js";
import type { TaskEnvelope } from "../src/types.js";

const ENV_KEYS = ["LLM_API_BASE_URL", "LLM_API_KEY", "LLM_DEFAULT_MODEL"] as const;

function withEnv<T>(work: () => T): T {
  const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.LLM_API_BASE_URL = "https://example.test/api/openai";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_DEFAULT_MODEL = "test-model";
  try {
    return work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function entryFor(definition: SpecialistAgentDefinition): RegisteredSpecialist {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    source: "project",
    enabled: true,
    valid: true,
    introspected: true,
    executability: "prompt-only",
    promptMode: definition.prompt.mode,
    enabledGroups: [],
    disabledGroups: [],
    deniedTools: [],
    skillMode: definition.skills?.mode ?? "auto",
    budget: definition.budget,
    optionsMode: definition.optionsMode ?? "planner",
    authorOptionsMode: definition.optionsMode ?? "planner",
    options: [],
    diagnostics: []
  };
}

function resolvedStub(partial: {
  id: string;
  skills?: SpecialistAgentDefinition["skills"];
  budget?: SpecialistAgentDefinition["budget"];
}) {
  const definition: SpecialistAgentDefinition = {
    id: partial.id,
    name: partial.id,
    description: "test specialist",
    prompt: { mode: "extend", content: "" },
    ...(partial.skills ? { skills: partial.skills } : {}),
    budget: partial.budget ?? {
      defaultMaxTurns: 12,
      maxTurnsCeiling: 40,
      epochTurnSlice: 20,
      epochTimeShare: 0.5
    }
  };
  return {
    ok: true as const,
    id: partial.id,
    definition,
    options: {},
    entry: entryFor(definition),
    diagnostics: []
  };
}

const skillSnapshot: SkillRegistrySnapshot = {
  scannedAt: new Date().toISOString(),
  diagnostics: [],
  skills: [
    {
      name: "recon-subdomain",
      description: "Enumerate subdomains",
      filePath: "/skills/recon-subdomain/SKILL.md",
      baseDir: "/skills/recon-subdomain",
      valid: true,
      enabled: true,
      modelInvocable: true
    },
    {
      name: "password-attack",
      description: "Password guessing",
      filePath: "/skills/password-attack/SKILL.md",
      baseDir: "/skills/password-attack",
      valid: true,
      enabled: true,
      modelInvocable: true
    }
  ]
};

function createController(input: {
  cwd: string;
  runtimeDir?: string;
  skillSelector?: (input: { taskGoal: string; snapshot: SkillRegistrySnapshot }) => Promise<{
    selected: SkillRegistrySnapshot["skills"];
    reasons: Record<string, string>;
    diagnostics: [];
  }>;
}) {
  const registry = new SpecialistRegistry({ cwd: input.cwd });
  return {
    registry,
    controller: new SecurityAgentController({
      cwd: input.cwd,
      runtimeDir: input.runtimeDir ?? mkdtempSync(join(tmpdir(), "controller-specialists-")),
      executorSandboxMode: "workspace",
      skillRegistry: { scan: () => skillSnapshot },
      specialistRegistry: registry,
      ...(input.skillSelector
        ? { skillSelector: input.skillSelector }
        : {
            skillSelector: async ({ snapshot }: { snapshot: SkillRegistrySnapshot }) => ({
              selected: snapshot.skills,
              reasons: {},
              diagnostics: []
            })
          })
    })
  };
}

test("Specialist budgets clamp Planner allocations without changing the general band", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "specialist-budget-"));
  await withEnv(async () => {
    const { controller } = createController({ cwd });
    const internals = controller as unknown as {
      taskEnvelopeFromSpec(
        spec: Record<string, unknown>,
        scope: string,
        specialist?: unknown
      ): TaskEnvelope;
      specialistRegistry: SpecialistRegistry;
    };
    const spec = {
      id: "task:one",
      goal: "goal",
      targetRefs: [],
      scopeRef: "scope:root",
      successCriteria: ["done"],
      priority: 1
    };
    assert.equal(internals.taskEnvelopeFromSpec(spec, "scope").budget?.maxTurns, 12);

    const bruteforce = await internals.specialistRegistry.resolve("bruteforce");
    assert.equal(bruteforce.ok, true);
    if (!bruteforce.ok) return;

    assert.equal(
      internals.taskEnvelopeFromSpec({ ...spec, budget: { maxTurns: 40 } }, "scope", bruteforce).budget?.maxTurns,
      30,
      "Planner allocation is capped by the Specialist ceiling"
    );
    assert.equal(
      internals.taskEnvelopeFromSpec(spec, "scope", bruteforce).budget?.maxTurns,
      18,
      "Specialist default applies when the Planner omits a budget"
    );
    assert.equal(
      internals.taskEnvelopeFromSpec({ ...spec, budget: { maxTurns: 5 } }, "scope", bruteforce).budget?.maxTurns,
      10,
      "The floor stays at the global minimum while the Agent default is at or above it"
    );
    const cheap = resolvedStub({
      id: "cheap",
      budget: { defaultMaxTurns: 4, maxTurnsCeiling: 8, epochTurnSlice: 2, epochTimeShare: 0.1 }
    });
    assert.equal(
      internals.taskEnvelopeFromSpec(spec, "scope", cheap).budget?.maxTurns,
      4,
      "A cheap Agent with a default below the global minimum keeps its own allocation"
    );
    assert.equal(
      internals.taskEnvelopeFromSpec({ ...spec, specialist: "bruteforce" }, "scope", bruteforce).specialist,
      "bruteforce"
    );
  });
});

test("Specialist Skill policies narrow per-task Skill selection", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "specialist-skills-"));
  await withEnv(async () => {
    const { controller } = createController({ cwd });
    const internals = controller as unknown as {
      selectTaskSkillDirs(goal: string, taskId: string, specialist?: unknown): Promise<string[]>;
    };

    assert.deepEqual(
      await internals.selectTaskSkillDirs("anything", "task:auto"),
      ["/skills/recon-subdomain", "/skills/password-attack"],
      "auto mode keeps the unconstrained selector"
    );
    assert.deepEqual(
      await internals.selectTaskSkillDirs(
        "anything",
        "task:pinned",
        resolvedStub({ id: "pinned", skills: { mode: "pinned", pinned: ["password-attack"] } })
      ),
      ["/skills/password-attack"],
      "pinned mode bypasses the selector"
    );
    assert.deepEqual(
      await internals.selectTaskSkillDirs(
        "anything",
        "task:off",
        resolvedStub({ id: "off", skills: { mode: "off" } })
      ),
      [],
      "off mode exposes no Skills"
    );
  });
});

test("unusable Specialists park the Task for the Planner instead of degrading silently", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "specialist-unavailable-"));
  await withEnv(async () => {
    const { controller, registry } = createController({ cwd });
    await registry.setEnabled("bruteforce", false);
    const internals = controller as unknown as {
      resolveSpecialistCandidates(candidates: TaskEnvelope[]): Promise<{
        runnable: TaskEnvelope[];
        resolutions: Map<string, unknown>;
      }>;
      awaitingPlannerTaskIds: Set<string>;
      executionLog: { window(input: { limit: number }): Promise<{ events: Array<{ eventType: string; taskId?: string; payload: Record<string, unknown> }> }> };
    };
    const disabledTask = {
      taskId: "task:bruteforce",
      goal: "guess credentials",
      targetRefs: [],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["done"],
      specialist: "bruteforce"
    };
    const generalTask = { ...disabledTask, taskId: "task:general", specialist: undefined };
    const resolved = await internals.resolveSpecialistCandidates([disabledTask, generalTask]);
    assert.deepEqual(resolved.runnable.map((task) => task.taskId), ["task:general"]);
    assert.equal(resolved.resolutions.get("task:general" as never) !== undefined, true);
    assert.equal(internals.awaitingPlannerTaskIds.has("task:bruteforce"), true);

    const unknownSpecialist = await internals.resolveSpecialistCandidates([
      { ...disabledTask, taskId: "task:unknown", specialist: "does-not-exist" }
    ]);
    assert.deepEqual(unknownSpecialist.runnable, []);

    const events = (await internals.executionLog.window({ limit: 50 })).events
      .filter((event) => event.eventType === "specialist_unavailable");
    assert.deepEqual(events.map((event) => event.taskId).sort(), ["task:bruteforce", "task:unknown"]);
    assert.equal(events[0]!.payload.specialistId, "bruteforce");
    assert.equal(events[0]!.payload.reason, "disabled");
    assert.equal(events[1]!.payload.reason, "unknown");
  });
});

test("planner decisions naming an unusable Specialist are rejected with a repair hint", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "specialist-planner-"));
  await withEnv(async () => {
    const { controller, registry } = createController({ cwd });
    const internals = controller as unknown as {
      validatePlannerSpecialists(decision: unknown): Promise<void>;
    };
    const decision = (specialist: string, specialistOptions?: Record<string, unknown>) => ({
      reason: "plan",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:x",
          goal: "g",
          targetRefs: [],
          scopeRef: "scope:root",
          successCriteria: ["done"],
          priority: 1,
          specialist,
          ...(specialistOptions ? { specialistOptions } : {})
        }]
      }]
    });
    await internals.validatePlannerSpecialists(decision("bruteforce"));
    // Only the options published in the catalog are writable per Task.
    await internals.validatePlannerSpecialists(decision("bruteforce", { threads: 2, maxTotalAttempts: 50 }));

    await assert.rejects(
      () => internals.validatePlannerSpecialists(decision("ghost-agent")),
      /unusable Specialist[\s\S]*ghost-agent[\s\S]*Available Specialists: bruteforce/
    );
    await assert.rejects(
      () => internals.validatePlannerSpecialists(decision("Bad_Id")),
      /not a valid Specialist id/
    );
    // Author-pinned and operator-owned options never become writable per Task.
    await assert.rejects(
      () => internals.validatePlannerSpecialists(decision("bruteforce", { stopOnLockout: false })),
      /does not accept Task-level option\(s\) stopOnLockout[\s\S]*tunable options are .*threads/
    );
    await assert.rejects(
      () => internals.validatePlannerSpecialists(decision("bruteforce", { material: "POST /login" })),
      /does not accept Task-level option\(s\) material/
    );
    // Options without an owning Specialist cannot be smuggled onto general.
    await assert.rejects(
      () => internals.validatePlannerSpecialists({
        reason: "plan",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:x",
            goal: "g",
            targetRefs: [],
            scopeRef: "scope:root",
            successCriteria: ["done"],
            priority: 1,
            specialistOptions: { threads: 2 }
          }]
        }]
      }),
      /specialistOptions requires the specialist field/
    );

    await registry.setEnabled("bruteforce", false);
    await assert.rejects(
      () => internals.validatePlannerSpecialists(decision("bruteforce")),
      /bruteforce \(disabled\)/
    );
    await registry.setEnabled("bruteforce", true);
  });
});

test("Task-level Specialist options are clamped into the author and operator boundary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "specialist-task-options-"));
  await withEnv(async () => {
    const { controller, registry } = createController({ cwd });
    const internals = controller as unknown as {
      applyTaskSpecialistOptions(
        task: { specialistOptions?: Record<string, unknown> },
        resolution: unknown
      ): { options: Record<string, unknown>; diagnostics: Array<{ code: string }> };
      specialistRegistry: SpecialistRegistry;
    };
    const resolution = await registry.resolve("bruteforce");
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;

    const apply = (specialistOptions?: Record<string, unknown>) =>
      internals.applyTaskSpecialistOptions(specialistOptions ? { specialistOptions } : {}, resolution);

    // No Task override means the resolved values are untouched.
    assert.equal(apply().options.threads, 4);

    // A Task may only lower the effort inside what the operator allowed.
    await registry.setOptions("bruteforce", { threads: 2, maxAttemptsPerAccount: 5 });
    const narrowed = await registry.resolve("bruteforce");
    assert.equal(narrowed.ok, true);
    if (!narrowed.ok) return;
    const applied = internals.applyTaskSpecialistOptions(
      { specialistOptions: { threads: 8, maxAttemptsPerAccount: 2, maxTotalAttempts: 50 } },
      narrowed
    );
    assert.equal(applied.options.threads, 2, "cannot exceed the operator boundary");
    assert.equal(applied.options.maxAttemptsPerAccount, 2);
    assert.equal(applied.options.maxTotalAttempts, 50);
    assert.equal(applied.diagnostics.some((entry) => entry.code === "specialist_option_clamped"), true);

    // A non-tunable key is ignored and reported rather than applied.
    const rejected = internals.applyTaskSpecialistOptions(
      { specialistOptions: { stopOnLockout: false, material: "planner material" } },
      narrowed
    );
    assert.equal(rejected.options.stopOnLockout, true);
    assert.equal(rejected.options.material, "");
    assert.equal(
      rejected.diagnostics.filter((entry) => entry.code === "specialist_option_not_planner_tunable").length,
      2
    );
  });
});

test("admitReadyTasks honours per-Specialist concurrency caps", () => {
  const task = (taskId: string, specialist?: string): TaskEnvelope => ({
    taskId,
    goal: taskId,
    targetRefs: [],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["done"],
    ...(specialist ? { specialist } : {})
  });
  const candidates = [
    task("task:a", "bruteforce"),
    task("task:b", "bruteforce"),
    task("task:c", GENERAL_SPECIALIST_ID),
    task("task:d")
  ];
  const admitted = admitReadyTasks(candidates, 4, new Set(), {
    caps: new Map([["bruteforce", 1]]),
    active: new Map()
  });
  assert.deepEqual(admitted.map((item) => item.taskId), ["task:a", "task:c", "task:d"]);

  const saturated = admitReadyTasks(candidates, 4, new Set(), {
    caps: new Map([["bruteforce", 1]]),
    active: new Map([["bruteforce", 1]])
  });
  assert.deepEqual(saturated.map((item) => item.taskId), ["task:c", "task:d"]);

  assert.deepEqual(
    admitReadyTasks(candidates, 4, new Set(), {}).map((item) => item.taskId),
    ["task:a", "task:b", "task:c", "task:d"]
  );
});
