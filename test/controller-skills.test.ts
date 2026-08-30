import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { SkillRegistrySnapshot } from "../src/skills/skill-registry.js";

test("controller resolves selected skill directories and falls back to none", async () => {
  const previous = {
    base: process.env.LLM_API_BASE_URL,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_DEFAULT_MODEL
  };
  process.env.LLM_API_BASE_URL = "https://example.test/api/openai";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_DEFAULT_MODEL = "test-model";
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
  try {
    const selected = new SecurityAgentController({
      cwd: process.cwd(),
      runtimeDir: mkdtempSync(join(tmpdir(), "controller-skills-")),
      executorSandboxMode: "workspace",
      skillRegistry: { scan: () => snapshot },
      skillSelector: async () => ({ selected: snapshot.skills, reasons: {}, diagnostics: [] })
    }) as unknown as { selectTaskSkillDirs(goal: string, taskId: string): Promise<string[]> };
    assert.deepEqual(await selected.selectTaskSkillDirs("find subdomains", "task:test"), ["/skills/recon-subdomain"]);

    const fallback = new SecurityAgentController({
      cwd: process.cwd(),
      runtimeDir: mkdtempSync(join(tmpdir(), "controller-no-skills-")),
      executorSandboxMode: "workspace",
      skillRegistry: { scan: () => { throw new Error("broken registry"); } }
    }) as unknown as { selectTaskSkillDirs(goal: string, taskId: string): Promise<string[]> };
    assert.deepEqual(await fallback.selectTaskSkillDirs("anything", "task:test"), []);
  } finally {
    restore("LLM_API_BASE_URL", previous.base);
    restore("LLM_API_KEY", previous.key);
    restore("LLM_DEFAULT_MODEL", previous.model);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
