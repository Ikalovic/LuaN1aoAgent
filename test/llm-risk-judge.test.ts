import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_JUDGE_SYSTEM_PROMPT,
  APPROVAL_JUDGE_TOOL_NAME,
  LlmJudgeUnavailableError,
  LlmRiskJudge,
  createApprovalJudgeSubmitTool,
  type RiskJudgeInvoker,
  type ToolRiskAssessment
} from "../src/approval/llm-risk-judge.js";

type Session = Parameters<RiskJudgeInvoker>[0];

function sessionMock() {
  const aborts: string[] = [];
  const session: Session = {
    prompt: async () => undefined,
    subscribe: () => () => undefined,
    abort: async () => { aborts.push("aborted"); }
  };
  return { session, aborts };
}

function invokerReturning(assessment: ToolRiskAssessment): RiskJudgeInvoker {
  return async (_session, prompt, input) => {
    const validated = input.validate?.(assessment);
    return validated;
  };
}

test("approval judge submit tool terminates with the assessment details", async () => {
  const tool = createApprovalJudgeSubmitTool();
  const result = await tool.execute("call-1", {
    verdict: "require_approval",
    intent: "批量扫描授权网段",
    riskLevel: "high",
    reason: "大规模扫描可能影响目标可用性"
  }, undefined, undefined, {} as never);
  assert.equal(result.terminate, true);
  const details = result.details as { verdict: string };
  assert.equal(details.verdict, "require_approval");
});

test("system prompt lists the risk criteria", () => {
  assert.match(APPROVAL_JUDGE_SYSTEM_PROMPT, /扩大攻击面/);
  assert.match(APPROVAL_JUDGE_SYSTEM_PROMPT, /大规模尝试/);
  assert.match(APPROVAL_JUDGE_SYSTEM_PROMPT, /超出授权范围/);
  assert.match(APPROVAL_JUDGE_SYSTEM_PROMPT, /approval_judge_submit/);
});

test("assess passes context into the prompt and returns the assessment", async () => {
  const { session } = sessionMock();
  const prompts: string[] = [];
  const judge = new LlmRiskJudge(session, async (_s, prompt) => {
    prompts.push(prompt);
    return { verdict: "allow", intent: "读取目标首页", riskLevel: "low", reason: "常规侦察" };
  });
  const assessment = await judge.assess({
    toolName: "web_fetch",
    toolArgs: { url: "http://10.0.0.5/" },
    taskGoal: "Find flags",
    scopeSummary: "10.0.0.0/24"
  });
  assert.equal(assessment.verdict, "allow");
  assert.equal(assessment.intent, "读取目标首页");
  assert.match(prompts[0], /Find flags/);
  assert.match(prompts[0], /10\.0\.0\.0\/24/);
  assert.match(prompts[0], /web_fetch/);
  assert.match(prompts[0], /http:\/\/10\.0\.0\.5\//);
});

test("assess forces the verdict in strict mode", async () => {
  const { session } = sessionMock();
  const judge = new LlmRiskJudge(session, invokerReturning({
    verdict: "allow",
    intent: "读取文件",
    riskLevel: "low",
    reason: ""
  }));
  const assessment = await judge.assess({
    toolName: "read",
    toolArgs: { path: "/etc/hosts" },
    forcedVerdict: "require_approval"
  });
  assert.equal(assessment.verdict, "require_approval");
  assert.equal(assessment.intent, "读取文件");
});

test("assess rejects invalid structured output", async () => {
  const { session } = sessionMock();
  const judge = new LlmRiskJudge(session, async () => ({ verdict: "maybe", intent: "", riskLevel: "low" }));
  await assert.rejects(
    () => judge.assess({ toolName: "bash", toolArgs: {} }),
    (error: unknown) => error instanceof LlmJudgeUnavailableError
  );
});

test("assess throws LlmJudgeUnavailableError when the invoke rejects", async () => {
  const { session } = sessionMock();
  const judge = new LlmRiskJudge(session, async () => { throw new Error("model down"); });
  await assert.rejects(
    () => judge.assess({ toolName: "bash", toolArgs: {} }),
    (error: unknown) => error instanceof LlmJudgeUnavailableError && /model down/.test(error.message)
  );
});

test("assess rejects after dispose", async () => {
  const { session, aborts } = sessionMock();
  const judge = new LlmRiskJudge(session, invokerReturning({
    verdict: "allow", intent: "x", riskLevel: "low", reason: ""
  }));
  judge.dispose();
  assert.deepEqual(aborts, ["aborted"]);
  await assert.rejects(
    () => judge.assess({ toolName: "bash", toolArgs: {} }),
    (error: unknown) => error instanceof LlmJudgeUnavailableError
  );
});

test("assess serializes concurrent requests on one judge", async () => {
  const { session } = sessionMock();
  const order: string[] = [];
  const judge = new LlmRiskJudge(session, async (_s, prompt) => {
    const name = prompt.includes("first") ? "first" : "second";
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end:${name}`);
    return { verdict: "allow", intent: "x", riskLevel: "low", reason: "" };
  });
  void judge.assess({ toolName: "first", toolArgs: {} });
  await judge.assess({ toolName: "second", toolArgs: {} });
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
});

test("default judge invoker keeps the structured tool name", async () => {
  const { session } = sessionMock();
  const judge = new LlmRiskJudge(session);
  assert.equal(judge instanceof LlmRiskJudge, true);
  assert.equal(APPROVAL_JUDGE_TOOL_NAME, "approval_judge_submit");
});
