import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_MODE_ENV,
  APPROVAL_MODES,
  classifyTool,
  isDangerousTool,
  isReadonlyTool,
  resolveApprovalMode,
  type ApprovalMode
} from "../src/approval/dangerous-tool-policy.js";

test("resolveApprovalMode normalizes valid inputs", () => {
  assert.equal(resolveApprovalMode(undefined), "auto");
  assert.equal(resolveApprovalMode(""), "auto");
  assert.equal(resolveApprovalMode("auto"), "auto");
  assert.equal(resolveApprovalMode("AUTO"), "auto");
  assert.equal(resolveApprovalMode("  off  "), "off");
  assert.equal(resolveApprovalMode("strict"), "strict");
});

test("resolveApprovalMode rejects unknown values", () => {
  assert.throws(() => resolveApprovalMode("paranoid"), /Invalid approval mode/);
});

test("approval mode env and modes constants stay aligned", () => {
  assert.equal(APPROVAL_MODE_ENV, "APPROVAL_MODE");
  assert.deepEqual(APPROVAL_MODES, ["off", "auto", "strict"]);
});

test("classifyTool in off mode never gates anything", () => {
  const mode: ApprovalMode = "off";
  assert.equal(classifyTool("bash", mode), "auto_allow");
  assert.equal(classifyTool("write", mode), "auto_allow");
  assert.equal(classifyTool("read", mode), "auto_allow");
  assert.equal(classifyTool("unknown_tool", mode), "auto_allow");
});

test("classifyTool in strict mode requires approval for every call", () => {
  const mode: ApprovalMode = "strict";
  assert.equal(classifyTool("read", mode), "require_approval");
  assert.equal(classifyTool("grep", mode), "require_approval");
  assert.equal(classifyTool("bash", mode), "require_approval");
  assert.equal(classifyTool("task_result_submit", mode), "require_approval");
});

test("classifyTool in auto mode allows read-only reconnaissance", () => {
  const mode: ApprovalMode = "auto";
  for (const toolName of [
    "read", "grep", "ls", "glob", "graph_query", "graph_search", "graph_trace",
    "evidence_list", "evidence_read", "artifact_read", "web_search",
    "vulnerability_search", "route_status", "task_result_submit"
  ]) {
    assert.equal(classifyTool(toolName, mode), "auto_allow", toolName);
  }
});

test("classifyTool in auto mode sends everything else to the judge", () => {
  const mode: ApprovalMode = "auto";
  assert.equal(classifyTool("bash", mode), "judge");
  assert.equal(classifyTool("write", mode), "judge");
  assert.equal(classifyTool("web_fetch", mode), "judge");
  assert.equal(classifyTool("some_future_tool", mode), "judge");
});

test("dangerous tool patterns cover writes, replays and scope expansion", () => {
  assert.equal(isDangerousTool("bash"), true);
  assert.equal(isDangerousTool("write"), true);
  assert.equal(isDangerousTool("edit"), true);
  assert.equal(isDangerousTool("artifact_write"), true);
  assert.equal(isDangerousTool("web_fetch"), true);
  assert.equal(isDangerousTool("browser_render"), true);
  assert.equal(isDangerousTool("route_open"), true);
  assert.equal(isDangerousTool("route_stop"), true);
  assert.equal(isDangerousTool("replay_http"), true);
  assert.equal(isDangerousTool("fofa_query"), true);
  assert.equal(isDangerousTool("credential_submit"), true);
  assert.equal(isDangerousTool("topology_validate"), true);
});

test("dangerous and readonly patterns are disjoint for core tools", () => {
  assert.equal(isReadonlyTool("bash"), false);
  assert.equal(isDangerousTool("read"), false);
  assert.equal(isReadonlyTool("read"), true);
});
