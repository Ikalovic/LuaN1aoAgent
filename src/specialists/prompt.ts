import type {
  SpecialistAgentDefinition,
  SpecialistOptionValue,
  SpecialistOptionValues,
  SpecialistRegistryDiagnostic,
  SpecialistToolGroup
} from "./types.js";

export const SPECIALIST_OPTION_PLACEHOLDER_PATTERN = /\{\{options\.([A-Za-z0-9_-]+)\}\}/g;

/**
 * Runtime-owned section appended to every Specialist system prompt. It carries
 * the invariants the runtime depends on, so an author-supplied prompt can never
 * drop them, in either `extend` or `replace` mode.
 */
export const SPECIALIST_RUNTIME_CONTRACT = `# Runtime Contract（由 Runtime 注入，不可被 Agent 覆盖）
1. 你只执行当前 TaskEnvelope；不得修改任务图、不得创建、改状态或删除 Task。
2. 每个 Epoch 都必须以 task_result_submit 结束；预算或监督信号要求收尾时立即提交阶段性 TaskResult。
3. 只在授权 Scope 内行动；不得扩大范围，不得把公开情报、候选技术或未验证假设当作已确认事实。
4. Runtime 给出的工具集就是本 Agent 的全部能力边界；不要假设存在被裁剪掉的工具，也不要尝试绕过沙箱。`;

export type SpecialistPromptRender = {
  systemPrompt: string;
  diagnostics: SpecialistRegistryDiagnostic[];
};

/**
 * Renders the Executor system prompt for one Specialist: base contract,
 * author content with `{{options.<key>}}` substitution, effective option values
 * and the runtime-owned contract tail.
 */
export function renderSpecialistSystemPrompt(input: {
  definition: SpecialistAgentDefinition;
  options: SpecialistOptionValues;
  basePrompt: string;
  enabledGroups: SpecialistToolGroup[];
  disabledGroups: SpecialistToolGroup[];
}): SpecialistPromptRender {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  const declared = Object.keys(input.definition.options ?? {});
  // A Specialist that adds no content and no options is the baseline Executor
  // profile (`general`): keep the historical system prompt byte-identical.
  if (input.definition.prompt.mode === "extend" && input.definition.prompt.content.trim().length === 0 && declared.length === 0) {
    return { systemPrompt: input.basePrompt, diagnostics };
  }
  const content = substituteOptionPlaceholders({
    content: input.definition.prompt.content,
    options: input.options,
    declared,
    specialistId: input.definition.id,
    diagnostics
  });
  const sections: string[] = [];
  if (input.definition.prompt.mode === "extend") {
    sections.push(input.basePrompt.trim());
    sections.push(`# Specialist: ${input.definition.name} (${input.definition.id})`);
  }
  if (content.trim()) sections.push(content.trim());
  const optionLines = declared.map((key) => `- ${key}: ${renderOptionValue(input.options[key])}`);
  if (optionLines.length > 0) {
    sections.push(`## 当前配置\n${optionLines.join("\n")}`);
  }
  sections.push(SPECIALIST_RUNTIME_CONTRACT);
  return { systemPrompt: sections.filter((section) => section.length > 0).join("\n\n"), diagnostics };
}

/** Placeholder diagnostics without rendering, for registry scans. */
export function specialistPromptPlaceholderDiagnostics(
  definition: SpecialistAgentDefinition
): SpecialistRegistryDiagnostic[] {
  const diagnostics: SpecialistRegistryDiagnostic[] = [];
  substituteOptionPlaceholders({
    content: definition.prompt.content,
    options: {},
    declared: Object.keys(definition.options ?? {}),
    specialistId: definition.id,
    diagnostics
  });
  return diagnostics;
}

function substituteOptionPlaceholders(input: {
  content: string;
  options: SpecialistOptionValues;
  declared: string[];
  specialistId: string;
  diagnostics: SpecialistRegistryDiagnostic[];
}): string {
  const declared = new Set(input.declared);
  const unknown = new Set<string>();
  const rendered = input.content.replace(SPECIALIST_OPTION_PLACEHOLDER_PATTERN, (match, key: string) => {
    if (!declared.has(key)) {
      unknown.add(key);
      return match;
    }
    return renderOptionValue(input.options[key]);
  });
  for (const key of unknown) {
    input.diagnostics.push({
      code: "specialist_prompt_placeholder_unknown",
      message: `Specialist ${input.specialistId} prompt references undeclared option "{{options.${key}}}"`,
      specialistId: input.specialistId
    });
  }
  return rendered;
}

export function renderOptionValue(value: SpecialistOptionValue | undefined): string {
  if (value === undefined) return "（未设置）";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "（空）";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
