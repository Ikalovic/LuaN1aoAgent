import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillRegistry } from "../src/skills/skill-registry.js";

test("missing skill root is an optional empty registry", () => {
  const registry = new SkillRegistry(join(tmpdir(), "missing-skill-root-for-luanniao"));
  assert.deepEqual(registry.scan().skills, []);
});

test("discovers valid skills, rejects escaping symlinks, and persists enablement", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-registry-"));
  const skillsRoot = join(root, ".agents", "skills");
  await mkdir(join(skillsRoot, "recon-subdomain"), { recursive: true });
  await writeFile(join(skillsRoot, "recon-subdomain", "SKILL.md"), [
    "---",
    "name: recon-subdomain",
    "description: Enumerate authorized subdomains.",
    "---",
    "Use passive and active subdomain enumeration."
  ].join("\n"));
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "SKILL.md"), "---\nname: escaped\ndescription: escaped\n---\n");
  await symlink(outside, join(skillsRoot, "escaped"));

  const registry = new SkillRegistry(skillsRoot);
  const snapshot = registry.scan();
  assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["recon-subdomain"]);
  assert.equal(snapshot.skills[0].valid, true);
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "skill_path_outside_root"), true);

  registry.setEnabled("recon-subdomain", false);
  assert.equal(new SkillRegistry(skillsRoot).scan().skills[0].enabled, false);
});

test("resolveSelection applies validity, enablement, allowlist, and denylist", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-selection-"));
  await mkdir(join(root, "one"), { recursive: true });
  await mkdir(join(root, "two"), { recursive: true });
  await writeFile(join(root, "one", "SKILL.md"), "---\nname: one\ndescription: First skill\n---\n");
  await writeFile(join(root, "two", "SKILL.md"), "---\nname: two\ndescription: Second skill\n---\n");
  const registry = new SkillRegistry(root);
  registry.scan();
  assert.deepEqual(registry.resolveSelection(["one", "two", "unknown"], ["one", "two"], ["two"]).map((x) => x.name), ["one"]);
});
