import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertContainerPath,
  buildContainerEnvironment,
  createDockerRunArgs,
  createDockerTaskSandbox,
  dockerSandboxNames,
  shouldUseDockerSandbox,
  type DockerRunner
} from "../src/executor-sandbox-docker.js";
import { createBrowserRenderTool } from "../src/tools/browser-tools.js";

const TEST_NETWORK = {
  networkName: "task-network",
  gatewayAddress: "172.30.0.2",
  dnsAddress: "172.30.0.2"
};

function fakeRunner(handler: (args: string[]) => { code?: number | null; stdout?: string | Buffer; stderr?: string }): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") {
      return { code: 0, stdout: Buffer.from("sha256:task-network"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "run" && args.includes("--privileged") && args.includes("nsenter")) {
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    const result = handler(args);
    return {
      code: result.code ?? 0,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? "")
    };
  };
  return { runner, calls };
}

test("docker run args enforce the hardened baseline and never the forbidden flags", () => {
  const args = createDockerRunArgs({
    containerName: "luanniao-exec-abc",
    workspaceDir: "/runtime/sandboxes/task-one-abc12345",
    image: "luanniao-executor:latest",
    environment: { PATH: "/usr/bin" },
    caCertHostPath: "/host/ca.crt",
    skillsRoots: ["/Users/x/.agents/skills"],
    network: TEST_NETWORK,
    runRef: "run:test",
    taskRef: "task:one"
  });
  const rendered = args.join(" ");
  for (const required of [
    "--user 1000:1000",
    "--label luanniao.managed=true",
    "--label luanniao.role=executor",
    "--label luanniao.run_ref=run:test",
    "--label luanniao.task_ref=task:one",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--read-only",
    "--tmpfs /tmp:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=1777",
    "--pids-limit 512",
    "--memory 4g",
    "--cpus 2",
    "type=bind,src=/runtime/sandboxes/task-one-abc12345,dst=/workspace",
    "--workdir /workspace",
    "type=bind,src=/host/ca.crt,dst=/etc/luanniao/traffic-proxy-ca.crt,readonly",
    "luanniao-executor:latest",
    "sleep infinity"
  ]) {
    assert.ok(rendered.includes(required), `missing: ${required}`);
  }
  assert.ok(rendered.includes("--network task-network"));
  assert.ok(rendered.includes("--dns 172.30.0.2"));
  for (const forbidden of ["--privileged", "--network host", "--pid host", "docker.sock", "type=volume", "dst=/tmp", "host.docker.internal"]) {
    assert.equal(rendered.includes(forbidden), false, `forbidden: ${forbidden}`);
  }
  assert.equal(rendered.includes("--cap-add"), false);
});

test("container and workspace names are deterministic per runtimeDir + taskId", () => {
  const first = dockerSandboxNames("/runtime/a", "task:one");
  const second = dockerSandboxNames("/runtime/a", "task:one");
  const third = dockerSandboxNames("/runtime/a", "task:two");
  assert.deepEqual(first, second);
  assert.notEqual(first.containerName, third.containerName);
  assert.notEqual(first.workspaceDir, third.workspaceDir);
  assert.match(first.containerName, /^luanniao-exec-[0-9a-f]{20}$/);
  assert.ok(first.workspaceDir.includes("sandboxes/task-one-"));
});

test("a successor keeps its own container identity while mounting the predecessor workspace", () => {
  const source = dockerSandboxNames("/runtime/a", "task:source");
  const successor = dockerSandboxNames("/runtime/a", "task:successor", "task:source");

  assert.notEqual(successor.containerName, source.containerName);
  assert.notEqual(successor.hostDir, source.hostDir);
  assert.equal(successor.workspaceDir, source.workspaceDir);
});

test("container environment drops proxy and host secrets while mapping the Gateway CA", () => {
  const { environment, caCertHostPath } = buildContainerEnvironment({
    HTTP_PROXY: "http://127.0.0.1:8080",
    LLM_API_KEY: "sk-should-never-leak",
    HOME: "/Users/someone"
  }, { caHostPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem" });
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.SSL_CERT_FILE, "/etc/luanniao/traffic-proxy-ca.crt");
  assert.equal(environment.REQUESTS_CA_BUNDLE, "/etc/luanniao/traffic-proxy-ca.crt");
  assert.equal(environment.CURL_CA_BUNDLE, "/etc/luanniao/traffic-proxy-ca.crt");
  assert.equal(environment.NODE_EXTRA_CA_CERTS, "/etc/luanniao/traffic-proxy-ca.crt");
  assert.equal(caCertHostPath, "/runtime/traffic/ca/mitmproxy-ca-cert.pem");
  assert.equal(environment.LLM_API_KEY, undefined, "host secrets must not leak into the container");
  assert.equal(environment.HOME, "/workspace/home");
});

test("transparent gateway mode removes explicit proxy state and uses the isolated task network", () => {
  const { environment, caCertHostPath } = buildContainerEnvironment({
    HTTP_PROXY: "http://127.0.0.1:8080",
    HTTPS_PROXY: "http://127.0.0.1:8080",
    LUANNIAO_CONNECT_PROXY: "http://127.0.0.1:8081"
  }, { caHostPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem" });
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.LUANNIAO_CONNECT_PROXY, undefined);
  assert.equal(caCertHostPath, "/runtime/traffic/ca/mitmproxy-ca-cert.pem");

  const args = createDockerRunArgs({
    containerName: "executor",
    workspaceDir: "/runtime/workspace",
    image: "luanniao-executor:latest",
    environment,
    caCertHostPath,
    skillsRoots: [],
    network: TEST_NETWORK
  });
  assert.ok(args.join(" ").includes("--network task-network"));
  assert.equal(args.includes("--add-host"), false);
});

test("assertContainerPath resolves relative workspace paths and rejects traversal", () => {
  assert.equal(assertContainerPath("/workspace/a/b.txt"), "/workspace/a/b.txt");
  assert.equal(assertContainerPath("a/b.txt"), "/workspace/a/b.txt");
  assert.equal(assertContainerPath("/home/user/.agents/skills/x", ["/home/user/.agents/skills"]), "/home/user/.agents/skills/x");
  assert.equal(assertContainerPath("/tmp/evidence.txt", ["/tmp"]), "/tmp/evidence.txt");
  assert.throws(() => assertContainerPath("/etc/passwd"), /denied path/);
  assert.throws(() => assertContainerPath("/workspace/../etc/passwd"), /denied path/);
  assert.throws(() => assertContainerPath("/tmp/../etc/passwd", ["/tmp"]), /denied path/);
});

test("shouldUseDockerSandbox fails closed for explicit docker without a daemon", async () => {
  const unavailable: DockerRunner = async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("no daemon") });
  await assert.rejects(() => shouldUseDockerSandbox("docker", unavailable), /failing|refusing|requires/i);
  assert.equal(await shouldUseDockerSandbox("auto", unavailable), false);
  const available: DockerRunner = async () => ({ code: 0, stdout: Buffer.from("28.0.0"), stderr: Buffer.alloc(0) });
  assert.equal(await shouldUseDockerSandbox("auto", available), true);
  assert.equal(await shouldUseDockerSandbox("seatbelt", available), false);
});

test("host sandbox modes do not probe the Docker daemon", async () => {
  let probeCount = 0;
  const runner: DockerRunner = async () => {
    probeCount += 1;
    return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("unavailable") };
  };

  assert.equal(await shouldUseDockerSandbox("workspace", runner), false);
  assert.equal(await shouldUseDockerSandbox("seatbelt", runner), false);
  assert.equal(await shouldUseDockerSandbox("bubblewrap", runner), false);
  assert.equal(probeCount, 0);
});

test("sandbox start reconciles containers by config and tool operations map to docker exec", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "lnw-docker-sandbox-"));
  const { workspaceDir, hostDir } = dockerSandboxNames(runtimeDir, "task:one");
  const additionalSkillsRoot = join(runtimeDir, "skills");
  mkdirSync(additionalSkillsRoot, { recursive: true });
  mkdirSync(join(workspaceDir, "home"), { recursive: true });
  chmodSync(workspaceDir, 0o755);
  chmodSync(join(workspaceDir, "home"), 0o755);
  const state: {
    running: boolean;
    configMatches: boolean;
    imageId: string;
    environmentMatches: boolean;
    extraEnvironment: boolean;
    extraMount: boolean;
    labeled: boolean;
    omittedMountDestination?: string;
  } = {
    running: true,
    configMatches: true,
    imageId: "sha256:executor-current",
    environmentMatches: true,
    extraEnvironment: false,
    extraMount: false,
    labeled: false
  };
  let allowedReadRoots: string[] = [];
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: "sha256:executor-current\n" };
    }
    if (args[0] === "inspect") {
      if (args.at(-1) === "gateway") return { stdout: "gateway-container-id" };
      const image = state.configMatches ? "luanniao-executor:latest" : "old-image";
      const configuredEnvironment = state.environmentMatches ? [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME=/workspace/home",
        "TMPDIR=/tmp",
        "LANG=C.UTF-8",
        "SSL_CERT_FILE=/etc/luanniao/traffic-proxy-ca.crt",
        "REQUESTS_CA_BUNDLE=/etc/luanniao/traffic-proxy-ca.crt",
        "CURL_CA_BUNDLE=/etc/luanniao/traffic-proxy-ca.crt",
        "NODE_EXTRA_CA_CERTS=/etc/luanniao/traffic-proxy-ca.crt",
        ...(state.extraEnvironment ? ["HTTP_PROXY=http://host-proxy:8080", "LLM_API_KEY=leaked"] : [])
      ] : ["PATH=/usr/bin"];
      const mounts = [
        {
          Type: "bind",
          Source: state.configMatches ? workspaceDir : "/other",
          Destination: "/workspace",
          RW: true
        },
        {
          Type: "bind",
          Source: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
          Destination: "/etc/luanniao/traffic-proxy-ca.crt",
          RW: false
        },
        {
          Type: "bind",
          Source: join(hostDir, "resolv.conf"),
          Destination: "/etc/resolv.conf",
          RW: false
        },
        ...allowedReadRoots.slice(1).map((root) => ({ Type: "bind", Source: root, Destination: root, RW: false })),
        ...(state.extraMount ? [{ Type: "bind", Source: "/Users/host/project", Destination: "/host-project", RW: true }] : [])
      ].filter((mount) => mount.Destination !== state.omittedMountDestination);
      return { stdout: JSON.stringify({
        Image: state.imageId,
        State: { Running: state.running },
        Config: {
          Image: image,
          User: "1000:1000",
          Labels: {
            "luanniao.managed": "true",
            "luanniao.role": "executor",
            ...(state.labeled ? {
              "luanniao.run_ref": "run:test",
              "luanniao.task_ref": "task:one"
            } : {})
          },
          Env: configuredEnvironment,
          WorkingDir: "/workspace",
          Cmd: ["sleep", "infinity"]
        },
        HostConfig: {
          ReadonlyRootfs: true,
          Privileged: false,
          CapDrop: ["ALL"],
          CapAdd: [],
          SecurityOpt: ["no-new-privileges:true"],
          Tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=536870912,uid=1000,gid=1000,mode=1777" },
          PidsLimit: 512,
          Memory: 4294967296,
          NanoCpus: 2000000000,
          NetworkMode: "task-network",
          Dns: ["172.30.0.2"]
        },
        Mounts: mounts
      }) };
    }
    if (args[0] === "exec" && args.some((arg) => arg.includes("cat --"))) return { stdout: Buffer.from("file-bytes") };
    if (args[0] === "exec" && args.some((arg) => arg.includes("stat"))) return { stdout: "directory\n" };
    if (args[0] === "exec" && args.some((arg) => arg.includes("ls -1A"))) return { stdout: "evidence.txt\nother.bin\n" };
    if (args[0] === "exec" && args.some((arg) => arg.includes("find "))) return { stdout: "/tmp/evidence.txt\n/tmp/other.bin\n" };
    if (args[0] === "exec" && args.some((arg) => arg.includes("'grep'"))) return { stdout: "/tmp/evidence.txt:1:needle\n" };
    if (args[0] === "exec" && args.some((arg) => arg.includes("/usr/bin/chromium"))) {
      return { stdout: "<html><body><div data-rendered=\"true\"></div></body></html>" };
    }
    if (args[0] === "run") {
      state.labeled = true;
      state.imageId = "sha256:executor-current";
    }
    if (args[0] === "stop") state.running = false;
    if (args[0] === "start") state.running = true;
    return {};
  });
  const sandbox = await createDockerTaskSandbox({
    runtimeDir,
    runRef: "run:test",
    taskId: "task:one",
    network: TEST_NETWORK,
    transparentCaPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
    additionalReadRoots: [additionalSkillsRoot],
    runner
  });
  allowedReadRoots = sandbox.allowedReadRoots;
  assert.equal(statSync(workspaceDir).mode & 0o777, 0o777);
  assert.equal(statSync(join(workspaceDir, "home")).mode & 0o777, 0o777);
  await sandbox.start();
  assert.equal(
    calls.some((call) => call[0] === "run" && !call.includes("--rm")),
    false,
    "running container with matching config must be reused"
  );
  assert.ok(calls.some((call) => call[0] === "run" && call.includes("--rm") && call.includes("--privileged") && call.includes("nsenter")));
  const networkInit = calls.find((call) => call[0] === "run" && call.includes("nsenter"));
  assert.ok(networkInit?.some((argument) => argument.includes("set -eu")));
  assert.equal(
    await import("node:fs/promises").then(({ readFile }) => readFile(join(hostDir, "resolv.conf"), "utf8")),
    `nameserver ${TEST_NETWORK.dnsAddress}\noptions ndots:0\n`
  );

  const tools = sandbox.createTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool])) as unknown as Record<string, {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  }>;
  const readResult = await byName.read!.execute("c1", { path: "/workspace/x.txt" });
  assert.ok(readResult.content.some((item) => item.text?.includes("file-bytes")));
  await assert.rejects(() => byName.read!.execute("c2", { path: "/etc/passwd" }), /denied path/);
  const tmpReadResult = await byName.read!.execute("c3", { path: "/tmp/evidence.txt" });
  assert.ok(tmpReadResult.content.some((item) => item.text?.includes("file-bytes")));
  const lsResult = await byName.ls!.execute("c4", { path: "/tmp" });
  assert.ok(lsResult.content.some((item) => item.text?.includes("evidence.txt")));
  const findResult = await byName.find!.execute("c5", { path: "/tmp", pattern: "*.txt" });
  assert.ok(findResult.content.some((item) => item.text?.includes("evidence.txt")));
  const grepResult = await byName.grep!.execute("c6", { path: "/tmp", pattern: "needle" });
  assert.ok(grepResult.content.some((item) => item.text?.includes("/tmp/evidence.txt:1:needle")));
  const tmpArtifact = await sandbox.readExecutorFile("/tmp/evidence.txt");
  assert.equal(tmpArtifact.toString("utf8"), "file-bytes");
  writeFileSync(join(workspaceDir, "host-note.txt"), "host-note-bytes");
  const workspaceArtifact = await sandbox.readExecutorFile("/workspace/host-note.txt");
  assert.equal(workspaceArtifact.toString("utf8"), "host-note-bytes");
  await assert.rejects(() => sandbox.readExecutorFile("/etc/passwd"), /denied path/);
  assert.equal(
    calls.filter((call) => call[0] === "exec").every((call) => call.includes(sandbox.containerName)),
    true,
    "file tools must only address paths through docker exec"
  );
  await byName.bash!.execute("c7", { command: "values=(one two); [[ ${#values[@]} -eq 2 ]]" });
  const bashCall = calls.find((call) => call[0] === "exec" && call[3] === "bash");
  assert.deepEqual(bashCall?.slice(3, 7), ["bash", "--noprofile", "--norc", "-c"]);
  assert.match(bashCall?.at(-1) ?? "", /setsid bash --noprofile --norc -c/);

  const browserTool = createBrowserRenderTool({ runtime: sandbox.browserRuntime });
  const browserResult = await browserTool.execute(
    "c8",
    { url: "http://target.test/", waitMs: 500, maxChars: 10_000 },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  assert.match(browserResult.content[0]?.type === "text" ? browserResult.content[0].text : "", /data-rendered/);
  const browserCall = calls.find((call) => call[0] === "exec" && call.some((argument) => argument.includes("/usr/bin/chromium")));
  assert.equal(browserCall?.includes("--env"), false);
  assert.match(browserCall?.at(-1) ?? "", /--no-sandbox/);
  assert.doesNotMatch(browserCall?.at(-1) ?? "", /--proxy-server/);

  await sandbox.quiesce();
  assert.ok(
    calls.some((call) => call[0] === "stop" && call.includes("--time") && call.includes("5")),
    "quiesce must synchronously stop every process while preserving the container"
  );
  assert.equal(state.running, false);
  await sandbox.start();
  assert.ok(calls.some((call) => call[0] === "start"), "stopped container with matching config is restarted");
  assert.equal(state.running, true);
  assert.equal(calls.some((call) => call[0] === "rm"), false, "matching config is not recreated");

  state.imageId = "sha256:executor-stale";
  const removalsBeforeImageRebind = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeImageRebind + 1,
    "container created from an older image ID is recreated even when Config.Image still matches the tag"
  );
  assert.equal(
    calls.filter((call) => call[0] === "image" && call[1] === "inspect").length,
    1,
    "the resolved target image ID is cached for this task sandbox"
  );

  state.running = true;
  state.environmentMatches = false;
  const removalsBeforeEnvironmentChange = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeEnvironmentChange + 1,
    "container without the complete CA environment is recreated"
  );

  state.environmentMatches = true;
  state.extraEnvironment = true;
  const removalsBeforeExtraEnvironment = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeExtraEnvironment + 1,
    "container with an extra environment entry is recreated"
  );

  state.extraEnvironment = false;
  state.extraMount = true;
  const removalsBeforeExtraMount = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeExtraMount + 1,
    "container with an extra host mount is recreated"
  );

  state.extraMount = false;
  state.omittedMountDestination = "/etc/luanniao/traffic-proxy-ca.crt";
  const removalsBeforeMissingCa = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeMissingCa + 1,
    "container missing the CA mount is recreated"
  );

  state.omittedMountDestination = additionalSkillsRoot;
  const removalsBeforeMissingSkills = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeMissingSkills + 1,
    "container missing a skills mount is recreated"
  );

  state.omittedMountDestination = "/workspace";
  const removalsBeforeMissingWorkspace = calls.filter((call) => call[0] === "rm").length;
  await sandbox.start();
  assert.equal(
    calls.filter((call) => call[0] === "rm").length,
    removalsBeforeMissingWorkspace + 1,
    "container missing the workspace mount is recreated"
  );

  state.omittedMountDestination = undefined;
  state.configMatches = false;
  await sandbox.start();
  assert.ok(calls.some((call) => call[0] === "rm" && call.includes("-f")), "mismatched container is removed");
  assert.ok(calls.some((call) => call[0] === "run"), "mismatched container is recreated");
  await sandbox.dispose();
  assert.ok(calls.at(-1)?.[0] === "rm");
});

test("docker sandbox refuses to replace or dispose an unmanaged deterministic container", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "lnw-docker-unmanaged-"));
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === "inspect" && args.at(-1) === "gateway") return { stdout: "gateway-container-id" };
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify({
        State: { Running: true },
        Config: { Labels: {} }
      }) };
    }
    return {};
  });
  const sandbox = await createDockerTaskSandbox({
    runtimeDir,
    runRef: "run:test",
    taskId: "task:unmanaged",
    network: TEST_NETWORK,
    transparentCaPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
    runner
  });

  await assert.rejects(() => sandbox.start(), /Refusing to replace unmanaged container/);
  await assert.rejects(() => sandbox.quiesce(), /Refusing to stop unmanaged container/);
  await assert.rejects(() => sandbox.dispose(), /Refusing to remove unmanaged container/);
  assert.equal(calls.some((call) => call[0] === "rm" || call[0] === "stop"), false);
});

test("docker sandbox refuses a labeled deterministic container owned by another run", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "lnw-docker-cross-run-"));
  const taskId = "task:owned";
  const { workspaceDir } = dockerSandboxNames(runtimeDir, taskId);
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === "inspect" && args.at(-1) === "gateway") return { stdout: "gateway-container-id" };
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify({
        State: { Running: true },
        Config: {
          Labels: {
            "luanniao.managed": "true",
            "luanniao.role": "executor",
            "luanniao.run_ref": "run:other",
            "luanniao.task_ref": taskId
          }
        },
        Mounts: [{
          Type: "bind",
          Source: workspaceDir,
          Destination: "/workspace",
          RW: true
        }]
      }) };
    }
    return {};
  });
  const sandbox = await createDockerTaskSandbox({
    runtimeDir,
    runRef: "run:current",
    taskId,
    network: TEST_NETWORK,
    transparentCaPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
    runner
  });

  await assert.rejects(() => sandbox.start(), /Refusing to replace unmanaged container/);
  await assert.rejects(() => sandbox.quiesce(), /Refusing to stop unmanaged container/);
  await assert.rejects(() => sandbox.dispose(), /Refusing to remove unmanaged container/);
  assert.equal(calls.some((call) => ["rm", "run", "start", "stop"].includes(call[0] ?? "")), false);
});

test("docker sandbox fails closed when an owned container image ID cannot be resolved", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "lnw-docker-image-inspect-"));
  const taskId = "task:image-inspect";
  const { workspaceDir } = dockerSandboxNames(runtimeDir, taskId);
  let imageInspectAttempts = 0;
  const { runner, calls } = fakeRunner((args) => {
    if (args[0] === "inspect" && args.at(-1) === "gateway") return { stdout: "gateway-container-id" };
    if (args[0] === "image" && args[1] === "inspect") {
      imageInspectAttempts += 1;
      return imageInspectAttempts === 1
        ? { code: 1, stderr: "manifest unavailable" }
        : { stdout: "sha256:executor-current\n" };
    }
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify({
        Image: "sha256:executor-stale",
        State: { Running: true },
        Config: {
          Labels: {
            "luanniao.managed": "true",
            "luanniao.role": "executor",
            "luanniao.run_ref": "run:test",
            "luanniao.task_ref": taskId
          }
        },
        Mounts: [{
          Type: "bind",
          Source: workspaceDir,
          Destination: "/workspace",
          RW: true
        }]
      }) };
    }
    return {};
  });
  const sandbox = await createDockerTaskSandbox({
    runtimeDir,
    runRef: "run:test",
    taskId,
    network: TEST_NETWORK,
    transparentCaPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
    runner
  });

  await assert.rejects(() => sandbox.start(), /Failed to resolve executor image.*manifest unavailable/);
  assert.equal(
    calls.some((call) => ["rm", "run", "start", "stop"].includes(call[0] ?? "")),
    false,
    "an unverifiable image must leave the owned container untouched"
  );
  await sandbox.start();
  assert.equal(imageInspectAttempts, 2, "a failed image lookup is not retained in the cache");
  assert.equal(calls.some((call) => call[0] === "rm"), true);
  assert.equal(calls.some((call) => call[0] === "run"), true);
});

test("docker bash uses the shared default timeout and honors overrides", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "lnw-docker-sandbox-timeout-"));
  const bashTimeouts: number[] = [];
  const runner: DockerRunner = async (args, options) => {
    if (args[0] === "network" && args[1] === "inspect") {
      return { code: 0, stdout: Buffer.from("sha256:task-network"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "run" && args.includes("--privileged") && args.includes("nsenter")) {
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "inspect" && args.at(-1) === "gateway") {
      return { code: 0, stdout: Buffer.from("gateway-container-id"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "inspect") {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("not found") };
    }
    if (args[0] === "exec" && args[3] === "bash") {
      bashTimeouts.push(options?.timeoutMs ?? 0);
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const previous = process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
  try {
    delete process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
    const sandbox = await createDockerTaskSandbox({
      runtimeDir,
      runRef: "run:test",
      taskId: "task:timeout",
      network: TEST_NETWORK,
      transparentCaPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
      runner
    });
    await sandbox.start();
    const bashTool = sandbox.createTools().find((tool) => tool.name === "bash");
    assert.ok(bashTool);
    await bashTool.execute("call:default", { command: "true" }, new AbortController().signal, () => undefined, {} as never);
    process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S = "7.9";
    await bashTool.execute("call:configured", { command: "true" }, new AbortController().signal, () => undefined, {} as never);
    await bashTool.execute("call:explicit", { command: "true", timeout: 11 }, new AbortController().signal, () => undefined, {} as never);
    assert.deepEqual(bashTimeouts, [300_000, 7_000, 11_000]);
  } finally {
    if (previous === undefined) {
      delete process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S;
    } else {
      process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S = previous;
    }
  }
});

test("docker start failure surfaces the daemon stderr", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "lnw-docker-sandbox-"));
  const { runner } = fakeRunner((args) => {
    if (args[0] === "inspect" && args.at(-1) === "gateway") return { stdout: "gateway-container-id" };
    if (args[0] === "inspect") return { code: 1 };
    if (args[0] === "run") return { code: 125, stderr: "image not found" };
    return {};
  });
  const sandbox = await createDockerTaskSandbox({
    runtimeDir,
    runRef: "run:test",
    taskId: "task:one",
    network: TEST_NETWORK,
    transparentCaPath: "/runtime/traffic/ca/mitmproxy-ca-cert.pem",
    runner
  });
  await assert.rejects(() => sandbox.start(), /image not found/);
});
