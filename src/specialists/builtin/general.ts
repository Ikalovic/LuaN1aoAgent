import { defineSpecialist } from "../sdk.js";
import { DEFAULT_SPECIALIST_BUDGET } from "../types.js";

/**
 * The default Executor profile. It is the fallback whenever a Task does not
 * name a Specialist, and its parameters mirror the historical Executor
 * constants so unnamed Tasks behave exactly as before.
 */
export const GENERAL_SPECIALIST_ID = "general";

export const generalSpecialist = defineSpecialist({
  id: GENERAL_SPECIALIST_ID,
  name: "通用 Executor",
  description: "默认执行者，拥有完整工具面与标准预算，适用于没有更合适专精 Agent 的通用任务。",
  whenToUse: "当任务不属于任何专精 Agent 的适用范围，或不确定该用哪个 Agent 时省略 specialist 字段；Runtime 会自动使用本 Agent。",
  prompt: {
    mode: "extend",
    content: ""
  },
  skills: { mode: "auto" },
  budget: { ...DEFAULT_SPECIALIST_BUDGET }
});
