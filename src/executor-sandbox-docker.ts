import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, matchesGlob, posix, resolve } from "node:path";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  truncateHead,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { ExecutorSandbox } from "./executor-sandbox.js";
import type { BrowserProcessRuntime } from "./tools/browser-tools.js";

export const DOCKER_SANDBOX_WORKDIR = "/workspace";
export const DOCKER_SANDBOX_TMPDIR = "/tmp";
export const DOCKER_CA_PATH = "/etc/luanniao/traffic-proxy-ca.crt";
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const DOCKER_CONTROL_TIMEOUT_MS = 120_000;

type DockerContainerInspect = {
  Image?: string;
  State?: { Running?: boolean };
  Config?: {
    Image?: string;
    User?: string;
    Labels?: Record<string, string>;
    Env?: unknown;
    WorkingDir?: string;
    Cmd?: unknown;
  };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    Privileged?: boolean;
    CapDrop?: unknown;
    CapAdd?: unknown;
    SecurityOpt?: unknown;
    Tmpfs?: unknown;
    PidsLimit?: number;
    Memory?: number;
    NanoCpus?: number;
    NetworkMode?: string;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
};

type ExpectedContainerSpec = {
  image: string;
  imageId: string;
  environment: NodeJS.ProcessEnv;
  workspaceDir: string;
  caCertHostPath: string;
  skillsRoots: string[];
  networkMode: string;
};

export type DockerExecResult = { code: number | null; stdout: Buffer; stderr: Buffer };

export type DockerRunner = (
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal; onKill?: () => void; onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void }
) => Promise<DockerExecResult>;

export type DockerTaskSandboxInput = {
  runtimeDir: string;
  runRef: string;
  taskId: string;
  image?: string;
  environment?: NodeJS.ProcessEnv;
  networkContainer: string;
  transparentCaPath: string;
  additionalReadRoots?: string[];
  runner?: DockerRunner;
};

export type DockerTaskSandbox = ExecutorSandbox & {
  containerName: string;
  image: string;
  start: () => Promise<void>;
  quiesce: () => Promise<void>;
  dispose: () => Promise<void>;
};

export function executorDockerImage(): string {
  return process.env.LUANNIAO_EXECUTOR_IMAGE?.trim() || "luanniao-executor:latest";
}

export function dockerSandboxNames(runtimeDir: string, taskId: string): { containerName: string; workspaceDir: string; hostDir: string } {
  const digest = createHash("sha256").update(`${resolve(runtimeDir)}${taskId}`).digest("hex").slice(0, 20);
  const slug = taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
  return {
    containerName: `luanniao-exec-${digest}`,
    workspaceDir: join(resolve(runtimeDir), "sandboxes", `${slug}-${digest.slice(0, 8)}`),
    hostDir: join(resolve(runtimeDir), "sandboxes", ".host", `${slug}-${digest.slice(0, 8)}`)
  };
}

export function createDockerRunArgs(input: {
  containerName: string;
  workspaceDir: string;
  image: string;
  environment: NodeJS.ProcessEnv;
  caCertHostPath: string;
  skillsRoots: string[];
  networkContainer: string;
  runRef?: string;
  taskRef?: string;
}): string[] {
  const args = [
    "run", "-d",
    "--name", input.containerName,
    "--label", "luanniao.managed=true",
    "--label", "luanniao.role=executor",
    ...(input.runRef ? ["--label", `luanniao.run_ref=${input.runRef}`] : []),
    ...(input.taskRef ? ["--label", `luanniao.task_ref=${input.taskRef}`] : []),
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    // Ephemeral scratch: writable and executable (PoCs/build artifacts run from
    // /tmp) but nosuid/nodev and size-capped; nothing here persists by design.
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=1777",
    "--pids-limit", "512",
    "--memory", "4g",
    "--cpus", "2",
    "--network", `container:${input.networkContainer}`,
    "--mount", `type=bind,src=${input.workspaceDir},dst=${DOCKER_SANDBOX_WORKDIR}`,
    "--workdir", DOCKER_SANDBOX_WORKDIR
  ];
  for (const [key, value] of Object.entries(input.environment)) {
    args.push("--env", `${key}=${value}`);
  }
  if (input.caCertHostPath) {
    args.push("--mount", `type=bind,src=${input.caCertHostPath},dst=${DOCKER_CA_PATH},readonly`);
  }
  // Skills are mounted at their real host paths (same layout the prompt and the
  // seatbelt backend use), which also keeps destinations unique per source.
  for (const skillsRoot of input.skillsRoots) {
    args.push("--mount", `type=bind,src=${skillsRoot},dst=${skillsRoot},readonly`);
  }
  args.push(input.image, "sleep", "infinity");
  return args;
}

export function buildContainerEnvironment(input: NodeJS.ProcessEnv | undefined, options: { caHostPath: string }): {
  environment: NodeJS.ProcessEnv;
  caCertHostPath: string;
} {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: posix.join(DOCKER_SANDBOX_WORKDIR, "home"),
    TMPDIR: "/tmp",
    LANG: "C.UTF-8"
  };
  void input;
  environment.SSL_CERT_FILE = DOCKER_CA_PATH;
  environment.REQUESTS_CA_BUNDLE = DOCKER_CA_PATH;
  environment.CURL_CA_BUNDLE = DOCKER_CA_PATH;
  environment.NODE_EXTRA_CA_CERTS = DOCKER_CA_PATH;
  return { environment, caCertHostPath: options.caHostPath };
}

export function assertContainerPath(candidatePath: string, extraReadRoots: string[] = []): string {
  const normalized = posix.resolve(DOCKER_SANDBOX_WORKDIR, candidatePath);
  const allowedRoots = [DOCKER_SANDBOX_WORKDIR, ...extraReadRoots];
  if (allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    return normalized;
  }
  throw new Error(`Docker sandbox denied path outside allowed roots: ${candidatePath}`);
}

let dockerAvailabilityProbe: Promise<boolean> | undefined;

export function dockerAvailable(runner?: DockerRunner): Promise<boolean> {
  if (runner) {
    return probeDocker(runner);
  }
  dockerAvailabilityProbe ??= probeDocker(defaultDockerRunner);
  return dockerAvailabilityProbe;
}

function probeDocker(runner: DockerRunner): Promise<boolean> {
  return runner(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 3_000 })
    .then((result) => result.code === 0)
    .catch(() => false);
}

export async function shouldUseDockerSandbox(requestedMode: string, runner: DockerRunner = defaultDockerRunner): Promise<boolean> {
  if (requestedMode !== "auto" && requestedMode !== "docker") return false;
  const available = await dockerAvailable(runner);
  if (requestedMode === "docker") {
    if (!available) {
      throw new Error("EXECUTOR_SANDBOX_MODE=docker requires a running Docker daemon; refusing to fall back to an unsandboxed mode");
    }
    return true;
  }
  return available;
}

export async function createDockerTaskSandbox(input: DockerTaskSandboxInput): Promise<DockerTaskSandbox> {
  const runner = input.runner ?? defaultDockerRunner;
  const image = input.image ?? executorDockerImage();
  const { containerName, workspaceDir, hostDir } = dockerSandboxNames(input.runtimeDir, input.taskId);
  // workspaceDir is bind-mounted into the container (host-visible data only; host
  // code must never load or execute from it). hostRoot is host-only and backs the
  // Pi prompt loader and session headers — the container never sees it.
  const hostRoot = hostDir;
  await mkdir(hostRoot, { recursive: true });
  await prepareContainerWritableDirectory(workspaceDir);
  await prepareContainerWritableDirectory(join(workspaceDir, "home"));
  const { environment, caCertHostPath } = buildContainerEnvironment(input.environment, {
    caHostPath: input.transparentCaPath
  });
  const skillsRoots = [
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
    ...(input.additionalReadRoots ?? [])
  ].filter((candidate) => existsSync(candidate));
  const runArgs = createDockerRunArgs({
    containerName,
    workspaceDir,
    image,
    environment,
    caCertHostPath,
    skillsRoots,
    networkContainer: input.networkContainer,
    runRef: input.runRef,
    taskRef: input.taskId
  });

  const exec = async (args: string[], options: Parameters<DockerRunner>[1] = {}): Promise<DockerExecResult> => {
    const result = await runner(args, { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS, ...options });
    return result;
  };

  let targetImageIdPromise: Promise<string> | undefined;
  const resolveTargetImageId = (): Promise<string> => {
    targetImageIdPromise ??= exec([
      "image", "inspect", "--format", "{{.Id}}", image
    ], { timeoutMs: 10_000 }).then((result) => {
      const imageId = result.stdout.toString("utf8").trim();
      if (result.code !== 0 || !imageId) {
        const detail = result.stderr.toString("utf8").trim()
          || result.stdout.toString("utf8").trim()
          || "image not found";
        throw new Error(`Failed to resolve executor image ${image}: ${detail}`);
      }
      return imageId;
    }).catch((error: unknown) => {
      targetImageIdPromise = undefined;
      throw error;
    });
    return targetImageIdPromise;
  };

  const execInContainer = (command: string, options: Parameters<DockerRunner>[1] = {}): Promise<DockerExecResult> =>
    exec(["exec", "-i", containerName, "sh", "-c", command], options);

  const execBashInContainer = (command: string, options: Parameters<DockerRunner>[1] = {}): Promise<DockerExecResult> =>
    exec(["exec", "-i", containerName, "bash", "--noprofile", "--norc", "-c", command], options);

  const requireSuccess = async (command: string, errorMessage: string): Promise<DockerExecResult> => {
    const result = await execInContainer(command);
    if (result.code !== 0) {
      throw new Error(`${errorMessage}: ${result.stderr.toString("utf8").trim() || `exit code ${result.code}`}`);
    }
    return result;
  };

  const requirePath = (candidatePath: string): string => assertContainerPath(candidatePath, [DOCKER_SANDBOX_TMPDIR, ...skillsRoots]);

  const createDockerGrepTool = (): ToolDefinition<any, any, any> => {
    const tool = createGrepToolDefinition(DOCKER_SANDBOX_WORKDIR);
    tool.execute = async (_toolCallId, params, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const input = params as {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      };
      const searchPath = requirePath(input.path?.trim() || DOCKER_SANDBOX_WORKDIR);
      const limit = Math.max(1, Math.floor(input.limit ?? 1_000));
      const args = [
        "grep",
        "--recursive",
        "--line-number",
        "--with-filename",
        "--binary-files=without-match",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules"
      ];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.glob) args.push(`--include=${input.glob}`);
      if (input.context && input.context > 0) args.push("--context", String(Math.floor(input.context)));
      args.push("--", input.pattern, searchPath);
      const result = await execInContainer(args.map(shellQuote).join(" "), { signal });
      if (result.code === 1) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      }
      if (result.code !== 0) {
        throw new Error(`grep failed: ${result.stderr.toString("utf8").trim() || `exit code ${result.code}`}`);
      }
      const allLines = result.stdout.toString("utf8").replace(/\n$/, "").split("\n");
      const limitedLines = allLines.slice(0, limit);
      const truncation = truncateHead(limitedLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const limitReached = allLines.length > limit;
      let output = truncation.content;
      if (limitReached) output += `\n\n[${limit} results limit reached]`;
      return {
        content: [{ type: "text", text: output }],
        details: limitReached || truncation.truncated
          ? {
              ...(limitReached ? { matchLimitReached: limit } : {}),
              ...(truncation.truncated ? { truncation } : {})
            }
          : undefined
      };
    };
    return tool;
  };

  const sandbox: DockerTaskSandbox = {
    root: DOCKER_SANDBOX_WORKDIR,
    hostRoot,
    workspaceDir,
    mode: "docker",
    containerName,
    image,
    browserRuntime: {
      chromePath: "/usr/bin/chromium",
      createProfile: async () => `/tmp/luanniao-chrome-${randomUUID()}`,
      removeProfile: async (profileDir) => {
        if (!profileDir.startsWith("/tmp/luanniao-chrome-")) {
          throw new Error(`Refusing to remove unexpected browser profile: ${profileDir}`);
        }
        await execInContainer(`rm -rf -- ${shellQuote(profileDir)}`, { timeoutMs: 10_000 });
      },
      execChrome: async (chromePath, args, timeoutMs, signal) => {
        const execId = randomUUID().replaceAll("-", "").slice(0, 12);
        const pidFile = `/tmp/.luanniao-browser-${execId}.pid`;
        const command = [chromePath, ...args].map(shellQuote).join(" ");
        const wrapped = `setsid ${command} & pid=$!; echo $pid > ${pidFile}; wait $pid`;
        const killInContainer = (): void => {
          void execInContainer(
            `pid=$(cat ${pidFile} 2>/dev/null) && { kill -TERM -"$pid" 2>/dev/null; sleep 2; kill -KILL -"$pid" 2>/dev/null; }; rm -f ${pidFile}`,
            { timeoutMs: 10_000 }
          ).catch(() => undefined);
        };
        const result = await exec(["exec", "-i", containerName, "sh", "-c", wrapped], {
          timeoutMs,
          signal,
          onKill: killInContainer
        });
        return {
          code: result.code,
          signal: result.code === null ? "SIGKILL" : null,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8")
        };
      },
      disableChromeSandbox: true,
      ignoreCertificateErrors: true
    } satisfies BrowserProcessRuntime,
    readExecutorFile: async (visiblePath) => {
      const normalized = assertContainerPath(visiblePath, [DOCKER_SANDBOX_TMPDIR]);
      if (normalized === DOCKER_SANDBOX_WORKDIR || normalized.startsWith(`${DOCKER_SANDBOX_WORKDIR}/`)) {
        const hostPath = join(workspaceDir, posix.relative(DOCKER_SANDBOX_WORKDIR, normalized));
        const metadata = await lstat(hostPath).catch(() => {
          throw new Error(`Executor file source does not exist: ${visiblePath}`);
        });
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error("Executor file source must be a regular file");
        }
        return readFile(hostPath);
      }
      const result = await execInContainer(
        `p=${shellQuote(normalized)}; if [ -f "$p" ] && [ ! -L "$p" ]; then bytes=$(wc -c < "$p"); if [ "$bytes" -gt ${MAX_EXEC_OUTPUT_BYTES} ]; then echo "Executor file source exceeds ${MAX_EXEC_OUTPUT_BYTES} bytes" >&2; exit 4; fi; cat -- "$p"; else echo "Executor file source must be a regular file" >&2; exit 3; fi`,
        { timeoutMs: 30_000 }
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.toString("utf8").trim() || `Executor file source is not readable: ${visiblePath}`);
      }
      return result.stdout;
    },
    allowedReadRoots: [DOCKER_SANDBOX_WORKDIR, ...skillsRoots],
    async start() {
      const networkInspect = await exec([
        "inspect", "--format", "{{.Id}}", input.networkContainer
      ], { timeoutMs: 10_000 });
      const networkContainerId = networkInspect.stdout.toString("utf8").trim();
      if (networkInspect.code !== 0 || !networkContainerId) {
        throw new Error(`Failed to inspect executor network container ${input.networkContainer}: ${networkInspect.stderr.toString("utf8").trim() || "container not found"}`);
      }
      const inspect = await exec([
        "inspect", "--format", "{{json .}}",
        containerName
      ], { timeoutMs: 10_000 });
      if (inspect.code === 0) {
        const inspected = parseContainerInspect(inspect.stdout);
        if (!isOwnedExecutorContainer(inspected, {
          runRef: input.runRef,
          taskRef: input.taskId,
          workspaceDir
        })) {
          throw new Error(`Refusing to replace unmanaged container ${containerName}`);
        }
        const targetImageId = await resolveTargetImageId();
        const configMatches = inspected !== undefined && containerSpecMatches(inspected, {
          image,
          imageId: targetImageId,
          environment,
          workspaceDir,
          caCertHostPath,
          skillsRoots,
          networkMode: `container:${networkContainerId}`
        });
        if (configMatches && inspected.State?.Running === true) {
          return;
        }
        if (configMatches) {
          const restarted = await exec(["start", containerName], { timeoutMs: 15_000 });
          if (restarted.code === 0) return;
        }
        await exec(["rm", "-f", containerName], { timeoutMs: 15_000 });
      }
      const created = await exec(runArgs, { timeoutMs: 60_000 });
      if (created.code !== 0) {
        throw new Error(`Failed to start executor container ${containerName}: ${created.stderr.toString("utf8").trim()}`);
      }
    },
    async quiesce() {
      const inspect = await exec([
        "inspect", "--format", "{{json .}}", containerName
      ], { timeoutMs: 10_000 });
      if (inspect.code !== 0) return;
      const inspected = parseContainerInspect(inspect.stdout);
      if (!isOwnedExecutorContainer(inspected, {
        runRef: input.runRef,
        taskRef: input.taskId,
        workspaceDir
      })) {
        throw new Error(`Refusing to stop unmanaged container ${containerName}`);
      }
      if (inspected?.State?.Running !== true) return;
      const stopped = await exec(["stop", "--time", "5", containerName], { timeoutMs: 15_000 });
      if (stopped.code !== 0) {
        throw new Error(`Failed to quiesce executor container ${containerName}: ${stopped.stderr.toString("utf8").trim()}`);
      }
    },
    async dispose() {
      const inspect = await exec([
        "inspect", "--format", "{{json .}}", containerName
      ], { timeoutMs: 10_000 });
      if (inspect.code !== 0) return;
      if (!isOwnedExecutorContainer(parseContainerInspect(inspect.stdout), {
        runRef: input.runRef,
        taskRef: input.taskId,
        workspaceDir
      })) {
        throw new Error(`Refusing to remove unmanaged container ${containerName}`);
      }
      const result = await exec(["rm", "-f", containerName], { timeoutMs: 15_000 })
        .catch((error: unknown) => ({
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(error instanceof Error ? error.message : String(error))
        }));
      if (result.code !== 0) {
        throw new Error(`Failed to dispose executor container ${containerName}: ${result.stderr.toString("utf8").trim()}`);
      }
    },
    createTools: () => [
      createReadToolDefinition(DOCKER_SANDBOX_WORKDIR, {
        operations: {
          access: async (absolutePath) => {
            await requireSuccess(`test -r ${shellQuote(requirePath(absolutePath))}`, "Path is not readable");
          },
          readFile: async (absolutePath) => {
            const result = await requireSuccess(`cat -- ${shellQuote(requirePath(absolutePath))}`, "Failed to read file");
            return result.stdout;
          }
        }
      }),
      createBashToolDefinition(DOCKER_SANDBOX_WORKDIR, {
        operations: {
          exec: async (command, _cwd, options) => {
            // Run the command in its own session so abort/timeout can kill the
            // whole process group inside the container, not just the docker CLI.
            const execId = randomUUID().replaceAll("-", "").slice(0, 12);
            const pidFile = `/tmp/.luanniao-exec-${execId}.pid`;
            const wrapped = `setsid bash --noprofile --norc -c ${shellQuote(command)} & pid=$!; echo $pid > ${pidFile}; wait $pid`;
            const killInContainer = (): void => {
              void execInContainer(
                `pid=$(cat ${pidFile} 2>/dev/null) && { kill -TERM -"$pid" 2>/dev/null; sleep 2; kill -KILL -"$pid" 2>/dev/null; }; rm -f ${pidFile}`,
                { timeoutMs: 10_000 }
              ).catch(() => undefined);
            };
            const result = await execBashInContainer(wrapped, {
              signal: options.signal,
              timeoutMs: (options.timeout ?? executorBashDefaultTimeoutSeconds()) * 1000,
              onKill: killInContainer,
              onData: options.onData ? (chunk) => options.onData(chunk) : undefined
            });
            return { exitCode: result.code };
          }
        }
      }),
      createDockerGrepTool(),
      createFindToolDefinition(DOCKER_SANDBOX_WORKDIR, {
        operations: {
          exists: async (absolutePath) => {
            const result = await execInContainer(`test -e ${shellQuote(requirePath(absolutePath))}`);
            return result.code === 0;
          },
          glob: async (pattern, searchRoot, options) => {
            const root = requirePath(searchRoot);
            const result = await requireSuccess(
              `find ${shellQuote(root)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`,
              "find failed"
            );
            const matches: string[] = [];
            for (const line of result.stdout.toString("utf8").split("\n")) {
              if (!line) continue;
              const relative = posix.relative(root, line);
              if (matchesGlob(relative, pattern) || (!pattern.includes("/") && matchesGlob(posix.basename(line), pattern))) {
                matches.push(line);
                if (matches.length >= options.limit) break;
              }
            }
            return matches;
          }
        }
      }),
      createLsToolDefinition(DOCKER_SANDBOX_WORKDIR, {
        operations: {
          exists: async (absolutePath) => {
            const result = await execInContainer(`test -e ${shellQuote(requirePath(absolutePath))}`);
            return result.code === 0;
          },
          stat: async (absolutePath) => {
            const result = await requireSuccess(
              `stat -c '%F' -- ${shellQuote(requirePath(absolutePath))}`,
              "Path does not exist"
            );
            const isDirectory = result.stdout.toString("utf8").trim() === "directory";
            return { isDirectory: () => isDirectory };
          },
          readdir: async (absolutePath) => {
            const result = await requireSuccess(
              `ls -1A -- ${shellQuote(requirePath(absolutePath))}`,
              "Failed to list directory"
            );
            return result.stdout.toString("utf8").split("\n").filter((line) => line.length > 0);
          }
        }
      })
    ] as ToolDefinition<any, any, any>[]
  };
  return sandbox;
}

async function defaultDockerRunner(
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; onKill?: () => void; onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void } = {}
): Promise<DockerExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timeoutMs = options.timeoutMs ?? DOCKER_CONTROL_TIMEOUT_MS;
    const killChild = (): void => {
      options.onKill?.();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(killChild, timeoutMs);
    timer.unref?.();
    const onAbort = () => killChild();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_EXEC_OUTPUT_BYTES) stdout.push(chunk);
      options.onData?.(chunk, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_EXEC_OUTPUT_BYTES) stderr.push(chunk);
      options.onData?.(chunk, "stderr");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        code: code ?? (signal ? null : 1),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
  });
}

async function prepareContainerWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o777 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Docker sandbox path must be a real directory: ${directory}`);
  }
  await chmod(directory, 0o777);
}

function executorBashDefaultTimeoutSeconds(): number {
  const value = Number(process.env.EXECUTOR_BASH_DEFAULT_TIMEOUT_S);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 300;
}

function parseContainerInspect(output: Buffer): DockerContainerInspect | undefined {
  try {
    const parsed = JSON.parse(output.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as DockerContainerInspect
      : undefined;
  } catch {
    return undefined;
  }
}

function containerSpecMatches(actual: DockerContainerInspect, expected: ExpectedContainerSpec): boolean {
  const expectedEnvironment = Object.entries(expected.environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  const expectedMounts = [
    mountIdentity("bind", expected.workspaceDir, DOCKER_SANDBOX_WORKDIR, true),
    ...(expected.caCertHostPath ? [mountIdentity("bind", expected.caCertHostPath, DOCKER_CA_PATH, false)] : []),
    ...expected.skillsRoots.map((root) => mountIdentity("bind", root, root, false))
  ];
  const actualMounts = Array.isArray(actual.Mounts)
    ? actual.Mounts.map((mount) => {
        if (!mount || typeof mount !== "object") return undefined;
        const value = mount as { Type?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown };
        return typeof value.Type === "string"
          && typeof value.Source === "string"
          && typeof value.Destination === "string"
          && typeof value.RW === "boolean"
          ? mountIdentity(value.Type, value.Source, value.Destination, value.RW)
          : undefined;
      })
    : [];
  const tmpfs = actual.HostConfig?.Tmpfs;
  return actual.Config?.Image === expected.image
    && actual.Image === expected.imageId
    && actual.Config.User === "1000:1000"
    && stringMultisetMatches(actual.Config.Env, expectedEnvironment)
    && actual.Config.WorkingDir === DOCKER_SANDBOX_WORKDIR
    && stringMultisetMatches(actual.Config.Cmd, ["sleep", "infinity"])
    && actual.HostConfig?.ReadonlyRootfs === true
    && actual.HostConfig.Privileged === false
    && stringMultisetMatches(actual.HostConfig.CapDrop, ["ALL"])
    && stringMultisetMatches(actual.HostConfig.CapAdd ?? [], [])
    && securityOptionsMatch(actual.HostConfig.SecurityOpt)
    && tmpfsOptionsMatch(tmpfs)
    && actual.HostConfig.PidsLimit === 512
    && actual.HostConfig.Memory === 4 * 1024 * 1024 * 1024
    && actual.HostConfig.NanoCpus === 2_000_000_000
    && actual.HostConfig.NetworkMode === expected.networkMode
    && stringMultisetMatches(actualMounts, expectedMounts);
}

function isManagedExecutorContainer(actual: DockerContainerInspect | undefined): boolean {
  return actual?.Config?.Labels?.["luanniao.managed"] === "true"
    && actual.Config.Labels["luanniao.role"] === "executor";
}

function isOwnedExecutorContainer(actual: DockerContainerInspect | undefined, expected: {
  runRef: string;
  taskRef: string;
  workspaceDir: string;
}): boolean {
  if (!isManagedExecutorContainer(actual)) return false;
  const labels = actual?.Config?.Labels ?? {};
  const labeledRunRef = labels["luanniao.run_ref"];
  const labeledTaskRef = labels["luanniao.task_ref"];
  if (labeledRunRef !== undefined || labeledTaskRef !== undefined) {
    return labeledRunRef === expected.runRef && labeledTaskRef === expected.taskRef;
  }
  return actual?.Mounts?.some((mount) => (
    mount?.Type === "bind"
    && mount.Source === expected.workspaceDir
    && mount.Destination === DOCKER_SANDBOX_WORKDIR
    && mount.RW === true
  )) === true;
}

function mountIdentity(type: string, source: string, destination: string, readWrite: boolean): string {
  return `${type}\u0000${source}\u0000${destination}\u0000${readWrite ? "rw" : "ro"}`;
}

function stringMultisetMatches(actual: unknown, expected: string[]): boolean {
  if (!Array.isArray(actual) || !actual.every((entry) => typeof entry === "string")) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.length === expectedSorted.length
    && actualSorted.every((entry, index) => entry === expectedSorted[index]);
}

function securityOptionsMatch(actual: unknown): boolean {
  if (!Array.isArray(actual) || actual.length !== 1 || typeof actual[0] !== "string") return false;
  return actual[0] === "no-new-privileges" || actual[0] === "no-new-privileges:true";
}

function tmpfsOptionsMatch(actual: unknown): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual);
  if (entries.length !== 1 || entries[0]?.[0] !== "/tmp" || typeof entries[0][1] !== "string") return false;
  const normalized = entries[0][1].split(",").map((option) => {
    if (option === "size=536870912") return "size=512m";
    return option;
  });
  return stringMultisetMatches(normalized, ["rw", "exec", "nosuid", "nodev", "size=512m", "uid=1000", "gid=1000", "mode=1777"]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
