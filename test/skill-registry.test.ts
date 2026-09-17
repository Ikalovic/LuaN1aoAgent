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

/**
 * The registry tests above use synthetic fixtures, so a malformed frontmatter in
 * a shipped skill would pass them and only surface at runtime as a
 * `skill_invalid` diagnostic — which is exactly how a description containing
 * ": " (a YAML nested-mapping marker) once shipped and silently dropped a skill
 * from the catalog. This test reads the real files.
 */
test("every shipped template skill parses without diagnostics", () => {
  const registry = new SkillRegistry(join(process.cwd(), "templates", "skills"));
  const snapshot = registry.scan();

  assert.deepEqual(
    snapshot.diagnostics,
    [],
    `shipped skills produced diagnostics: ${JSON.stringify(snapshot.diagnostics, null, 2)}`
  );
  assert.ok(snapshot.skills.length > 0, "templates/skills must ship at least one skill");

  for (const skill of snapshot.skills) {
    assert.equal(skill.valid, true, `${skill.name} must be valid`);
    assert.ok(skill.description && skill.description.length > 0, `${skill.name} needs a description`);
  }

  // The two skills the internet-osint Specialist allowlists must both be present,
  // otherwise that Agent silently runs with an empty knowledge surface.
  const names = snapshot.skills.map((skill) => skill.name);
  for (const required of ["osint-query-strategy", "osint-source-reliability"]) {
    assert.ok(names.includes(required), `templates/skills is missing ${required}`);
  }
});

test("a skill description containing a colon is still parsed as one scalar", async () => {
  // Regression guard for the exact YAML hazard: an unquoted `: ` inside a plain
  // scalar starts a nested mapping and invalidates the whole file.
  const root = await mkdtemp(join(tmpdir(), "skill-colon-"));
  const skillsRoot = join(root, ".agents", "skills");
  await mkdir(join(skillsRoot, "colon-plain"), { recursive: true });
  await writeFile(join(skillsRoot, "colon-plain", "SKILL.md"), [
    "---",
    "name: colon-plain",
    "description: How to use the site, inurl and filetype operators.",
    "---",
    "Body."
  ].join("\n"));
  await mkdir(join(skillsRoot, "colon-broken"), { recursive: true });
  await writeFile(join(skillsRoot, "colon-broken", "SKILL.md"), [
    "---",
    "name: colon-broken",
    "description: How to use site:, inurl: and filetype: operators.",
    "---",
    "Body."
  ].join("\n"));

  const snapshot = new SkillRegistry(skillsRoot).scan();
  assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["colon-plain"]);
  const broken = snapshot.diagnostics.find((diagnostic) => diagnostic.code === "skill_invalid");
  assert.ok(broken, "an unquoted colon must be reported, not silently ignored");
  // The YAML parser cannot know the name, so the registry derives it from the
  // containing directory; without that the alert is an unattributed YAML error.
  assert.equal(broken.skillName, "colon-broken");
  assert.match(broken.message, /Nested mappings/);
});
