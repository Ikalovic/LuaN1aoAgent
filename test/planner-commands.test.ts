import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePlannerDecision,
  validatePlannerArtifactRefs,
  validatePlannerBasedOnRefs
} from "../src/planner-commands.js";

test("allows empty apply_commands as a no-op graph update", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [],
    reason: "No graph mutation is needed; schedule existing ready tasks.",
    basedOnRefs: ["task:ready"]
  });

  assert.equal(decision.decision, undefined);
  assert.deepEqual(decision.commands, []);
  assert.equal(decision.reason, "No graph mutation is needed; schedule existing ready tasks.");
});

test("defaults omitted apply_commands commands to an empty no-op list", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    reason: "No graph mutation is needed.",
    basedOnRefs: []
  });

  assert.deepEqual(decision.commands, []);
});

test("requires the same Planner reason in structured and text fallback normalization", () => {
  assert.throws(() => normalizePlannerDecision({ commands: [] }), /Planner reason is required/);
  assert.throws(() => normalizePlannerDecision({ commands: [], reason: "   " }), /Planner reason is required/);
});

test("preserves incremental task budget extensions", () => {
  const decision = normalizePlannerDecision({
    commands: [{
      kind: "patch_task",
      taskId: "task:checkpointed",
      patch: { additionalTurns: 6 },
      basedOnRefs: ["event:checkpoint"]
    }],
    reason: "Continue the same causal task"
  });

  const command = decision.commands?.[0];
  assert.equal(command?.kind, "patch_task");
  assert.deepEqual(command?.kind === "patch_task" ? command.patch : undefined, { additionalTurns: 6 });
});

test("preserves append-only Task objectives with their observable criteria", () => {
  const decision = normalizePlannerDecision({
    commands: [{
      kind: "patch_task",
      taskId: "task:foothold",
      patch: {
        appendObjectives: [{
          goal: "Use the foothold to obtain the remaining internal result",
          successCriteria: ["the remaining result is persisted"]
        }]
      }
    }],
    reason: "New evidence extends the same causal workstream"
  });

  const command = decision.commands?.[0];
  assert.deepEqual(command?.kind === "patch_task" ? command.patch.appendObjectives : undefined, [{
    goal: "Use the foothold to obtain the remaining internal result",
    successCriteria: ["the remaining result is persisted"]
  }]);
});

test("preserves explicit sequential Executor context continuation", () => {
  const decision = normalizePlannerDecision({
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:successor",
        goal: "Use the established session to obtain the final result",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        successCriteria: ["Final result is persisted"],
        priority: 1,
        dependsOnTaskRefs: ["task:foothold"],
        continueFromTaskRef: "task:foothold"
      }]
    }],
    reason: "The predecessor goal is complete and the next goal needs its live working context"
  });

  const command = decision.commands?.[0];
  assert.equal(command?.kind, "create_tasks");
  assert.equal(command?.kind === "create_tasks" ? command.tasks[0]?.continueFromTaskRef : undefined,
    "task:foothold");
});

test("drops legacy Planner-authored constraints from task definitions", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:legacy",
        goal: "Resolve the remaining uncertainty",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        constraints: ["Treat an unverified payload as confirmed"],
        successCriteria: ["Record an observable result"],
        priority: 1
      }]
    }, {
      kind: "patch_task",
      taskId: "task:existing",
      patch: {
        constraints: ["Force a specific attack step"],
        priority: 2
      }
    }],
    reason: "Legacy decision",
    basedOnRefs: ["goal:root"]
  });

  const create = decision.commands?.[0];
  const patch = decision.commands?.[1];
  assert.equal(create?.kind, "create_tasks");
  assert.equal("constraints" in (create?.kind === "create_tasks" ? create.tasks[0]! : {}), false);
  assert.equal(patch?.kind, "patch_task");
  assert.deepEqual(patch?.kind === "patch_task" ? patch.patch : undefined, { priority: 2 });
  assert.throws(() => normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "patch_task",
      taskId: "task:existing",
      patch: { constraints: ["Only legacy constraints"] }
    }],
    reason: "Legacy constraint-only patch",
    basedOnRefs: []
  }), /patch contains no supported fields/);
});

test("accepts archived as the logical deletion status for old tasks", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "set_task_status",
      taskId: "task:obsolete",
      status: "archived",
      reason: "Superseded by a confirmed path"
    }],
    reason: "Remove the obsolete task from active scheduling",
    basedOnRefs: ["task:replacement"]
  });

  assert.equal(decision.commands?.[0]?.kind, "set_task_status");
  assert.equal(
    decision.commands?.[0]?.kind === "set_task_status" ? decision.commands[0].status : undefined,
    "archived"
  );
});

test("rejects Executor outcome states as Planner-owned Task lifecycle states", () => {
  assert.throws(() => normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "set_task_status",
      taskId: "task:checkpointed",
      status: "partial",
      reason: "Mirror the Executor outcome"
    }],
    reason: "Mirror the Executor outcome",
    basedOnRefs: ["task:checkpointed"]
  }), /Invalid task status: partial/);
});

test("resolves unambiguous abbreviated Artifact Refs to their full form", async () => {
  const fullRef = "artifact:337dc6f4-5b92-4d6b-8a98-97cd1500cfa7";
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:reuse-artifact",
        goal: "Reuse artifact:337dc6f4 before probing",
        targetRefs: ["scope:root"],
        scopeRef: "scope:root",
        constraints: [],
        successCriteria: ["Reuse the prior evidence"],
        priority: 1
      }],
      basedOnRefs: ["goal:root", "artifact:337dc6f4"]
    }],
    reason: "Evidence artifact:337dc6f4 confirms reuse",
    basedOnRefs: ["legacy:top-level-is-ignored"]
  });

  const resolved = await validatePlannerArtifactRefs(decision, async () => [{ artifactRef: fullRef }]);

  assert.equal(resolved.basedOnRefs, undefined);
  assert.equal(resolved.reason, `Evidence ${fullRef} confirms reuse`);
  const command = resolved.commands?.[0];
  assert.deepEqual(command?.basedOnRefs, ["goal:root", fullRef]);
  const goal = command?.kind === "create_tasks" ? command.tasks[0]?.goal : undefined;
  assert.equal(goal, `Reuse ${fullRef} before probing`);
});

test("strips historical Planner control fields while preserving command-local provenance", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "set_task_status",
      taskId: "task:done",
      status: "completed",
      reason: "historical duplicate reason",
      basedOnRefs: ["event:verified"]
    }],
    reason: "Accept the persisted result",
    basedOnRefs: ["legacy:top-level"]
  });

  assert.deepEqual(decision, {
    commands: [{
      kind: "set_task_status",
      taskId: "task:done",
      status: "completed",
      basedOnRefs: ["event:verified"]
    }],
    reason: "Accept the persisted result"
  });
});

test("does not mangle already-full Artifact Refs sharing the abbreviated prefix", async () => {
  const fullRef = "artifact:337dc6f4-5b92-4d6b-8a98-97cd1500cfa7";
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [],
    reason: `Short artifact:337dc6f4 next to full ${fullRef}`,
    basedOnRefs: ["goal:root"]
  });

  const resolved = await validatePlannerArtifactRefs(decision, async () => [{ artifactRef: fullRef }]);

  assert.equal(resolved.reason, `Short ${fullRef} next to full ${fullRef}`);
});

test("rejects unknown or ambiguous Artifact Refs", async () => {
  const unknown = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [],
    reason: "Continue from artifact:deadbeef",
    basedOnRefs: ["goal:root"]
  });
  await assert.rejects(
    () => validatePlannerArtifactRefs(unknown, async () => [
      { artifactRef: "artifact:337dc6f4-5b92-4d6b-8a98-97cd1500cfa7" }
    ]),
    /unknown or ambiguous Artifact Ref\(s\): artifact:deadbeef/
  );

  const ambiguous = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [],
    reason: "Continue from artifact:337dc6f4",
    basedOnRefs: ["goal:root"]
  });
  await assert.rejects(
    () => validatePlannerArtifactRefs(ambiguous, async () => [
      { artifactRef: "artifact:337dc6f4-5b92-4d6b-8a98-97cd1500cfa7" },
      { artifactRef: "artifact:337dc6f4-aaaa-4d6b-8a98-97cd1500cfa7" }
    ]),
    /ambiguous, candidates:/
  );
});

test("accepts exact Artifact Refs embedded in Planner task text", async () => {
  const fullRef = "artifact:337dc6f4-5b92-4d6b-8a98-97cd1500cfa7";
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:reuse-artifact",
        goal: `Reuse ${fullRef} before probing`,
        targetRefs: ["scope:root"],
        scopeRef: "scope:root",
        constraints: [],
        successCriteria: ["Reuse the prior evidence"],
        priority: 1
      }]
    }],
    reason: "Continue from prior evidence",
    basedOnRefs: ["goal:root"]
  });

  await validatePlannerArtifactRefs(decision, async () => [{ artifactRef: fullRef }]);
});

test("resolves unambiguous abbreviated non-Artifact basedOnRefs", async () => {
  const decision = normalizePlannerDecision({
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:follow-up",
        goal: "Resolve the projected finding",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        successCriteria: ["Persist a decisive result"],
        priority: 1
      }],
      basedOnRefs: ["projected:f6918853"]
    }],
    reason: "Follow the projected finding"
  });

  const validated = await validatePlannerBasedOnRefs(decision, {
    listArtifacts: async () => [],
    referenceCandidates: (prefix) => ["projected:f6918853-complete"].filter((ref) => ref.startsWith(prefix))
  });

  assert.deepEqual(validated.commands?.[0]?.basedOnRefs, ["projected:f6918853-complete"]);
});

test("accepts exact persisted Graph, Event and capability basedOnRefs", async () => {
  const persistedRefs = new Set([
    "projected:f6918853-complete",
    "event:8f9f5fb0-complete",
    "route:79d1f4c2-complete"
  ]);
  const decision = normalizePlannerDecision({
    commands: [{
      kind: "patch_task",
      taskId: "task:follow-up",
      patch: { additionalTurns: 5 },
      basedOnRefs: [...persistedRefs]
    }],
    reason: "Continue from exact persisted state"
  });

  const validated = await validatePlannerBasedOnRefs(decision, {
    listArtifacts: async () => [],
    referenceCandidates: (prefix) => [...persistedRefs].filter((reference) => reference.startsWith(prefix))
  });

  assert.deepEqual(validated.commands?.[0]?.basedOnRefs, [...persistedRefs]);
});

test("rejects unknown or ambiguous non-Artifact basedOnRefs", async () => {
  const decision = normalizePlannerDecision({
    commands: [{
      kind: "patch_task",
      taskId: "task:follow-up",
      patch: { additionalTurns: 5 },
      basedOnRefs: ["projected:f6918853"]
    }],
    reason: "Continue from persisted state"
  });
  await assert.rejects(() => validatePlannerBasedOnRefs(decision, {
    listArtifacts: async () => [],
    referenceCandidates: () => ["projected:f6918853-a", "projected:f6918853-b"]
  }), /ambiguous, candidates:/);
});
