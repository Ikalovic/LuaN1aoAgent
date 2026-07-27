import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlannerDecision, validatePlannerArtifactRefs } from "../src/planner-commands.js";

test("allows empty apply_commands as a no-op graph update", () => {
  const decision = normalizePlannerDecision({
    decision: "apply_commands",
    commands: [],
    reason: "No graph mutation is needed; schedule existing ready tasks.",
    basedOnRefs: ["task:ready"]
  });

  assert.equal(decision.decision, "apply_commands");
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
      }]
    }],
    reason: "Evidence artifact:337dc6f4 confirms reuse",
    basedOnRefs: ["goal:root", "artifact:337dc6f4"]
  });

  const resolved = await validatePlannerArtifactRefs(decision, async () => [{ artifactRef: fullRef }]);

  assert.deepEqual(resolved.basedOnRefs, ["goal:root", fullRef]);
  assert.equal(resolved.reason, `Evidence ${fullRef} confirms reuse`);
  const command = resolved.commands?.[0];
  const goal = command?.kind === "create_tasks" ? command.tasks[0]?.goal : undefined;
  assert.equal(goal, `Reuse ${fullRef} before probing`);
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
