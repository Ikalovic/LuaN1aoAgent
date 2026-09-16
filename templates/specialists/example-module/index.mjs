/**
 * Example Specialist Agent module.
 *
 * Copy this directory to `.agents/specialists/<id>/`, set `id` in
 * `specialist.json` to the directory name, and enable the Agent from the Web
 * "Capabilities → Specialist Agents" tab (or by setting `enabled: true`).
 *
 * The default export may be either a definition object or a factory that
 * receives the runtime API (`Type`, `defineTool`, `defineSpecialist`,
 * `defineSpecialistTool`, `toolGroups`, `defaultBudget`). The definition `id`
 * must equal the directory name.
 *
 * SECURITY: this file runs inside the runtime process once the Agent is
 * enabled. The runtime validates the path and the exported shape; it does not
 * sandbox the module. Only install Agents you trust.
 */
export default function createExampleAgent(api) {
  return {
    id: "example-module",
    name: "示例模块 Agent",
    version: "1.0.0",
    description: "演示如何用代码注册一个带自定义工具的专精 Agent。",
    whenToUse: "仅用于本地验证 SDK 是否工作；请改写为真实用途后再启用。",
    prompt: {
      mode: "extend",
      content: `# 附加方法
1. 先确认当前 Task 的成功条件，再选择最小验证动作。
2. 需要探测时使用 probe_target 工具，保留每一次探测的输入与判定信号。
3. 目标参数：{{options.target}}；重试次数：{{options.retries}}。`
    },
    tools: {
      // Narrow the surface: this Agent never needs attack-surface search or the
      // external credential database.
      disableGroups: ["fofa", "beekeeper"]
    },
    skills: { mode: "auto" },
    budget: {
      defaultMaxTurns: 8,
      maxTurnsCeiling: 12,
      epochTurnSlice: 6,
      epochTimeShare: 0.3
    },
    concurrency: { maxParallelTasks: 1 },
    // The restrictive default: nothing is freely editable unless handed over.
    optionsMode: "planner",
    options: {
      target: {
        type: "string",
        title: "探测目标",
        description: "自定义工具默认作用的目标地址或标识。任务目标类参数，显式交给用户。",
        default: "",
        maxLength: 512,
        authority: "user"
      },
      retries: {
        type: "number",
        title: "重试次数",
        // A maximum is what makes an option Planner-tunable: the operator
        // declares a smaller bound, the Planner picks a value inside it.
        description: "单次探测的重试次数。用户可设上限，具体取值由 Planner 在边界内选择。",
        default: 2,
        minimum: 0,
        maximum: 10,
        integer: true
      }
    },
    createTools: (context) => [
      api.defineTool({
        name: "probe_target",
        label: "Probe target",
        description: "Record one controlled probe request for a target and return the runtime context it observed.",
        parameters: api.Type.Object({
          target: api.Type.String({ minLength: 1, maxLength: 512 }),
          note: api.Type.Optional(api.Type.String({ maxLength: 512 }))
        }, { additionalProperties: false }),
        execute: async (_toolCallId, params) => {
          const result = {
            target: params.target,
            note: params.note ?? "",
            taskId: context.taskId,
            specialistId: context.specialistId,
            configuredTarget: context.options.target,
            enabledGroups: context.enabledGroups
          };
          await context.executionLog?.append({
            taskId: context.taskId,
            role: "executor",
            eventType: "example_probe",
            summary: `probe ${params.target}`,
            payload: result
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      })
    ]
  };
}
