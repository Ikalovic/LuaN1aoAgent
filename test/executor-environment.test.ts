import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_TOOL_PROBE_LIST,
  getExecutorEnvironmentFacts
} from "../src/executor-environment.js";

test("workspace facts state the real cwd, $TMPDIR and the no-/workspace boundary", async () => {
  const facts = await getExecutorEnvironmentFacts(
    { mode: "workspace", sandboxRoot: "/tmp/run/sandboxes/task-1", platform: "macOS arm64" },
    async () => ["curl", "nmap"]
  );

  assert.ok(facts.includes("cwd：/tmp/run/sandboxes/task-1"));
  assert.ok(facts.includes("$TMPDIR"));
  assert.ok(facts.includes("macOS arm64"));
  assert.ok(facts.includes("workspace"));
  assert.ok(facts.includes("可用工具：curl nmap"));
  assert.ok(facts.split("\n").length <= 25);
});

test("host facts never present /workspace as a usable directory", async () => {
  for (const mode of ["workspace", "macos-seatbelt", "linux-bubblewrap"] as const) {
    const facts = await getExecutorEnvironmentFacts(
      { mode, sandboxRoot: "/tmp/run/sandboxes/task-2", platform: "macOS arm64" },
      async () => []
    );
    assert.ok(facts.includes("不存在 /workspace"), `${mode} must deny /workspace`);
    assert.ok(!facts.includes("cwd：/workspace"), `${mode} must not claim /workspace as cwd`);
    assert.ok(!facts.includes("或 /workspace"), `${mode} must not offer /workspace as an alternative`);
  }
});

test("host mode labels match the sandbox backend", async () => {
  const seatbelt = await getExecutorEnvironmentFacts(
    { mode: "macos-seatbelt", sandboxRoot: "/tmp/sb" },
    async () => []
  );
  const bubblewrap = await getExecutorEnvironmentFacts(
    { mode: "linux-bubblewrap", sandboxRoot: "/tmp/bw" },
    async () => []
  );
  assert.ok(seatbelt.includes("macOS Seatbelt"));
  assert.ok(bubblewrap.includes("Linux Bubblewrap"));
});

test("a failing tool probe silently omits the tool line instead of failing", async () => {
  const facts = await getExecutorEnvironmentFacts(
    { mode: "workspace", sandboxRoot: "/tmp/run/sandboxes/task-3" },
    async () => {
      throw new Error("probe exploded");
    }
  );

  assert.ok(facts.includes("cwd：/tmp/run/sandboxes/task-3"));
  assert.ok(!facts.includes("可用工具"));
});

test("docker facts describe the container workspace, tmpfs, uid and transparent gateway", async () => {
  const probedWith: string[][] = [];
  const facts = await getExecutorEnvironmentFacts(
    {
      mode: "docker",
      sandboxRoot: "/host/sandboxes/task-4",
      containerWorkdir: "/workspace",
      tmpdir: "/tmp",
      image: "luanniao-executor:latest",
      platform: "linux arm64"
    },
    async (toolNames) => {
      probedWith.push(toolNames);
      return ["python3", "curl", "nc"];
    }
  );

  assert.deepEqual(probedWith, [EXECUTOR_TOOL_PROBE_LIST]);
  assert.ok(facts.includes("luanniao-executor:latest"));
  assert.ok(facts.includes("linux arm64"));
  assert.ok(facts.includes("cwd：/workspace"));
  assert.ok(facts.includes("跨 epoch 持久"));
  assert.ok(facts.includes("tmp：/tmp"));
  assert.ok(facts.includes("512MB"));
  assert.ok(facts.includes("uid 1000"));
  assert.ok(facts.includes("Gateway"));
  assert.ok(facts.includes("无原始套接字"));
  assert.ok(facts.includes("不要设置代理环境变量"));
  assert.ok(facts.includes("可用工具：python3 curl nc"));
  assert.ok(facts.split("\n").length <= 25);
});

test("docker facts degrade silently when the image probe fails", async () => {
  const facts = await getExecutorEnvironmentFacts(
    { mode: "docker", sandboxRoot: "/host/sandboxes/task-5", image: "missing:image" },
    async () => {
      throw new Error("daemon unavailable");
    }
  );

  assert.ok(facts.includes("cwd：/workspace"));
  assert.ok(!facts.includes("可用工具"));
});

test("the default host probe resolves real PATH tools and caches per process", async () => {
  const facts = await getExecutorEnvironmentFacts({ mode: "workspace", sandboxRoot: "/tmp/run" });
  const toolLine = facts.split("\n").find((line) => line.startsWith("- 可用工具："));
  assert.ok(toolLine, "host PATH probe should find at least one common tool");
  assert.ok(toolLine.includes("curl"));
  assert.ok(toolLine.includes("tar"));
});
