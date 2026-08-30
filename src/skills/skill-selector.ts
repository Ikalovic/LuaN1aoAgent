import { createSkillSelectorAgentSession } from "../agents.js";
import type { LlmRuntime } from "../llm-config.js";
import { invokeStructured, type ProviderAdmissionOptions } from "../pi-runner.js";
import type { RegisteredSkill, SkillRegistrySnapshot } from "./skill-registry.js";

export type SkillSelectionSubmission = {
  selections: Array<{ name: string; reason: string }>;
};

export type SkillSelectionResult = {
  selected: RegisteredSkill[];
  reasons: Record<string, string>;
  diagnostics: Array<{ code: string; message: string; skillName?: string }>;
};

export function validateSkillSelection(
  snapshot: SkillRegistrySnapshot,
  submission: SkillSelectionSubmission,
  allowlist?: string[],
  denylist?: string[]
): { selected: RegisteredSkill[]; reasons: Record<string, string>; rejected: Array<{ name: string; code: string }> } {
  const byName = new Map(snapshot.skills.map((skill) => [skill.name, skill]));
  const allowed = allowlist ? new Set(allowlist) : undefined;
  const denied = new Set(denylist ?? []);
  const selected: RegisteredSkill[] = [];
  const reasons: Record<string, string> = {};
  const rejected: Array<{ name: string; code: string }> = [];
  const seen = new Set<string>();
  for (const selection of submission.selections.slice(0, 16)) {
    if (seen.has(selection.name)) continue;
    seen.add(selection.name);
    const skill = byName.get(selection.name);
    let code: string | undefined;
    if (!skill) code = "unknown_skill";
    else if (!skill.valid) code = "invalid_skill";
    else if (!skill.enabled) code = "disabled_skill";
    else if (!skill.modelInvocable) code = "model_invocation_disabled";
    else if (allowed && !allowed.has(skill.name)) code = "skill_not_allowed";
    else if (denied.has(skill.name)) code = "skill_denied";
    if (code) {
      rejected.push({ name: selection.name, code });
      continue;
    }
    selected.push(skill!);
    reasons[skill!.name] = selection.reason.slice(0, 500);
  }
  return { selected, reasons, rejected };
}

export async function selectSkillsForTask(input: {
  taskGoal: string;
  snapshot: SkillRegistrySnapshot;
  llmRuntime?: LlmRuntime;
  cwd?: string;
  allowlist?: string[];
  denylist?: string[];
  providerAdmission?: ProviderAdmissionOptions;
  invoke?: () => Promise<SkillSelectionSubmission>;
}): Promise<SkillSelectionResult> {
  const eligible = input.snapshot.skills.filter((skill) => skill.valid && skill.enabled && skill.modelInvocable);
  if (eligible.length === 0) return { selected: [], reasons: {}, diagnostics: [] };
  try {
    const submission = input.invoke
      ? await input.invoke()
      : await invokeSelection(input, eligible);
    const validated = validateSkillSelection(input.snapshot, submission, input.allowlist, input.denylist);
    return {
      selected: validated.selected,
      reasons: validated.reasons,
      diagnostics: validated.rejected.map((rejected) => ({
        code: rejected.code,
        message: `Skill selection rejected: ${rejected.name}`,
        skillName: rejected.name
      }))
    };
  } catch (error) {
    return {
      selected: [],
      reasons: {},
      diagnostics: [{ code: "skill_selection_failed", message: error instanceof Error ? error.message : String(error) }]
    };
  }
}

async function invokeSelection(
  input: Parameters<typeof selectSkillsForTask>[0],
  eligible: RegisteredSkill[]
): Promise<SkillSelectionSubmission> {
  if (!input.llmRuntime || !input.cwd) throw new Error("Skill selector LLM runtime is unavailable");
  const created = await createSkillSelectorAgentSession({
    cwd: input.cwd,
    llmRuntime: input.llmRuntime,
    providerAdmission: input.providerAdmission
  });
  try {
    const metadata = eligible.map((skill) => ({ name: skill.name, description: skill.description }));
    return await invokeStructured<SkillSelectionSubmission>(
      created.session,
      `<task_goal>${input.taskGoal}</task_goal>\n<available_skills>${JSON.stringify(metadata)}</available_skills>`,
      {
        toolName: "skill_selection_submit",
        idleTimeoutMs: 30_000,
        hardTimeoutMs: 60_000,
        terminateOnToolError: true,
        admission: input.providerAdmission,
        validate: validateSubmission
      }
    );
  } finally {
    created.session.dispose();
  }
}

function validateSubmission(value: unknown): SkillSelectionSubmission {
  if (!value || typeof value !== "object" || !Array.isArray((value as { selections?: unknown }).selections)) {
    throw new Error("skill_selection_submit must contain selections");
  }
  return {
    selections: (value as { selections: unknown[] }).selections.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid skill selection");
      const record = entry as { name?: unknown; reason?: unknown };
      if (typeof record.name !== "string" || typeof record.reason !== "string") throw new Error("Invalid skill selection");
      return { name: record.name, reason: record.reason };
    })
  };
}
