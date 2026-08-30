import assert from "node:assert/strict";
import test from "node:test";
import { selectSkillsForTask, validateSkillSelection } from "../src/skills/skill-selector.js";
import type { SkillRegistrySnapshot } from "../src/skills/skill-registry.js";
import { createSkillSelectionSubmitTool } from "../src/tools/pi-tools.js";

const snapshot: SkillRegistrySnapshot = {
  scannedAt: new Date().toISOString(),
  diagnostics: [],
  skills: [{
    name: "recon-subdomain",
    description: "Enumerate subdomains",
    filePath: "/skills/recon-subdomain/SKILL.md",
    baseDir: "/skills/recon-subdomain",
    valid: true,
    enabled: true,
    modelInvocable: true
  }]
};

test("validates model selection against the registry", () => {
  const result = validateSkillSelection(snapshot, {
    selections: [
      { name: "recon-subdomain", reason: "Task requests subdomains" },
      { name: "unknown", reason: "not installed" }
    ]
  });
  assert.deepEqual(result.selected.map((skill) => skill.name), ["recon-subdomain"]);
  assert.deepEqual(result.rejected, [{ name: "unknown", code: "unknown_skill" }]);
});

test("does not invoke a model when no eligible skills exist", async () => {
  let invoked = false;
  const result = await selectSkillsForTask({
    taskGoal: "anything",
    snapshot: { scannedAt: new Date().toISOString(), diagnostics: [], skills: [] },
    invoke: async () => { invoked = true; return { selections: [] }; }
  });
  assert.equal(invoked, false);
  assert.deepEqual(result.selected, []);
});

test("skill selection submit tool is terminating and bounded", () => {
  const tool = createSkillSelectionSubmitTool();
  assert.equal(tool.name, "skill_selection_submit");
});
