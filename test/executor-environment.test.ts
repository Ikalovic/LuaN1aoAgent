import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_TOOL_PROBE_LIST,
  getExecutorEnvironmentFacts,
  parseExecutorImageFacts,
  renderExecutorEnvironmentFacts
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
      platform: "linux arm64",
      networkHealth: {
        status: "healthy",
        tcpDataPlane: true,
        broker: true,
        icmp: "supported",
        checkedAt: "2026-08-31T00:00:00.000Z"
      }
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
  assert.ok(facts.includes("TCP 数据面：已验证可用"));
  assert.ok(facts.includes("Broker：可达"));
  assert.ok(facts.includes("ICMP：支持"));
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
  // A host missing the last probed tool must still report the tools it has: the
  // shell loop's status is its last iteration's status, so the probe forces a
  // zero exit. `crunch` is deliberately probed even though most hosts lack it.
  assert.ok(toolLine, "host PATH probe should find at least one common tool");
  assert.ok(toolLine.includes("curl"));
  assert.ok(toolLine.includes("tar"));
});

test("the probe list asks about the bruteforce toolchain the image ships", () => {
  for (const tool of ["hydra", "medusa", "hashcat", "sqlmap", "ffuf", "gobuster", "dirb", "crunch"]) {
    assert.ok(EXECUTOR_TOOL_PROBE_LIST.includes(tool), `${tool} must be probed`);
  }
});

test("docker facts advertise the verified wordlist paths", () => {
  const facts = renderExecutorEnvironmentFacts(
    { mode: "docker", sandboxRoot: "/host/sandboxes/task-6" },
    {
      tools: ["hydra", "hashcat"],
      wordlists: ["/opt/luanniao/wordlists/passwords-common.txt", "/opt/luanniao/wordlists/default-credentials.txt"]
    }
  );

  const wordlistLine = facts.split("\n").find((line) => line.startsWith("- 预置字典"));
  assert.ok(wordlistLine, "a verified wordlist must be advertised");
  assert.ok(wordlistLine.includes("/opt/luanniao/wordlists/passwords-common.txt"));
  assert.ok(wordlistLine.includes("hydra -C"));
  assert.ok(facts.split("\n").length <= 25);
});

test("no wordlists and no tools means no dangling lines", () => {
  const facts = renderExecutorEnvironmentFacts(
    { mode: "docker", sandboxRoot: "/host/sandboxes/task-7" },
    { tools: [], wordlists: [] }
  );

  assert.ok(!facts.includes("预置字典"));
  assert.ok(!facts.includes("可用工具"));
});

test("image facts accept both label schema versions and fail closed otherwise", () => {
  const v2 = parseExecutorImageFacts(
    JSON.stringify({
      version: 2,
      uid: 1000,
      rawSockets: false,
      tools: ["hydra", "hashcat", 7],
      wordlists: ["/opt/luanniao/wordlists/passwords-common.txt"]
    })
  );
  assert.deepEqual(v2.tools, ["hydra", "hashcat"]);
  assert.deepEqual(v2.wordlists, ["/opt/luanniao/wordlists/passwords-common.txt"]);

  // Version 1 labels predate the wordlist list and must keep working.
  const v1 = parseExecutorImageFacts(JSON.stringify({ version: 1, uid: 1000, rawSockets: false, tools: ["nmap"] }));
  assert.deepEqual(v1, { tools: ["nmap"], wordlists: [] });

  const rejected: Array<string | undefined> = [
    undefined,
    "",
    "not json",
    "[]",
    JSON.stringify({ version: 3, uid: 1000, rawSockets: false, tools: ["nmap"] }),
    // A label claiming raw sockets would describe a different sandbox than the
    // one the container actually runs in, so no tool list is better than a
    // half-trusted one.
    JSON.stringify({ version: 2, uid: 1000, rawSockets: true, tools: ["nmap"] }),
    JSON.stringify({ version: 2, uid: 0, rawSockets: false, tools: ["nmap"] })
  ];
  for (const raw of rejected) {
    assert.deepEqual(parseExecutorImageFacts(raw), { tools: [], wordlists: [] }, `must reject ${String(raw)}`);
  }
});

