import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskNetworkHealth } from "./connectivity/network-sandbox-manager.js";

const execFileAsync = promisify(execFile);

export type ExecutorEnvironmentFactsInput = {
  mode: "docker" | "macos-seatbelt" | "linux-bubblewrap" | "workspace";
  sandboxRoot: string;
  containerWorkdir?: string;
  tmpdir?: string;
  image?: string;
  platform?: string;
  hostNetworkRuntime?: string;
  networkHealth?: TaskNetworkHealth;
};

// Returns the subset of toolNames present on PATH. Injectable so tests and the
// controller wiring can substitute a fake; implementations must never throw.
export type ExecutorToolProbe = (toolNames: string[]) => Promise<string[]>;

// Common pentest/development tools probed once and cached (per image for
// Docker, per process for host backends) so Executor sessions do not spend
// their first turns rediscovering the environment.
export const EXECUTOR_TOOL_PROBE_LIST = [
  "python3", "python", "pip", "curl", "wget", "nc", "ncat", "nmap", "sqlmap",
  "go", "node", "npm", "git", "gcc", "make", "jq", "unzip", "tar", "dig",
  "whois", "ssh", "sshpass", "hydra", "john", "hashcat", "gdb", "objdump",
  "strings", "file", "xxd", "base64"
];

const TOOL_PROBE_TIMEOUT_MS = 5_000;

let hostToolCache: Promise<string[]> | undefined;
const dockerToolCache = new Map<string, Promise<string[]>>();
const EXECUTOR_FACTS_LABEL = "io.luanniao.executor.facts";

export async function getExecutorEnvironmentFacts(
  input: ExecutorEnvironmentFactsInput,
  probe?: ExecutorToolProbe
): Promise<string> {
  const tools = await probeExecutorTools(input, probe);
  const lines = ["# Executor 环境事实（Runtime 已核实，直接采信，不要重复探测）"];
  if (input.mode === "docker") {
    const workdir = input.containerWorkdir ?? "/workspace";
    const tmp = input.tmpdir ?? "/tmp";
    lines.push(
      `- 运行模式：Docker 任务容器（镜像 ${input.image ?? "luanniao-executor:latest"}，${input.platform ?? defaultPlatform("linux")}）`,
      `- 宿主网络运行时：${input.hostNetworkRuntime ?? process.platform}`,
      `- cwd：${workdir}；可写、跨 epoch 持久（bind mount 到宿主任务目录）`,
      `- tmp：${tmp}；tmpfs，上限 512MB，可写可执行，易失不持久`,
      "- 身份：uid 1000；无附加 capability；无原始套接字；根文件系统只读；可写位置只有 cwd 与 tmp",
      "- 网络：独立任务网络以 Gateway 为唯一出口；HTTP/HTTPS 透明内容代理，其他协议只做路由与连接元数据审计；不要设置代理环境变量；IPv6 已禁用"
    );
    if (input.networkHealth) {
      const health = input.networkHealth;
      const tcp = health.tcpDataPlane ? "已验证可用" : `不可用（${health.status}）`;
      const broker = health.broker ? "可达" : "不可达";
      const icmp = health.icmp === "supported" ? "支持" : "经 SOCKS 路由时不支持";
      lines.push(`- Runtime 网络健康：TCP 数据面：${tcp}；Broker：${broker}；ICMP：${icmp}；检查时间 ${health.checkedAt}`);
    }
  } else {
    lines.push(
      `- 运行模式：${hostModeLabel(input.mode)}`,
      `- cwd：${input.sandboxRoot}；可写、跨 epoch 持久`,
      "- 临时文件：使用 $TMPDIR（指向沙箱内 tmp，可写）",
      `- 操作系统：${input.platform ?? defaultPlatform(hostPlatform(input.mode))}`,
      "- 路径边界：不存在 /workspace；不要在文件系统根目录创建目录，一切文件操作在 cwd 与 $TMPDIR 内进行"
    );
  }
  if (tools.length > 0) {
    lines.push(`- 可用工具：${tools.join(" ")}`);
  }
  return lines.join("\n");
}

function hostModeLabel(mode: "macos-seatbelt" | "linux-bubblewrap" | "workspace"): string {
  if (mode === "macos-seatbelt") return "macOS Seatbelt 沙箱（cwd 可写，系统目录只读）";
  if (mode === "linux-bubblewrap") return "Linux Bubblewrap 沙箱（cwd 与 tmp 可写，系统目录只读 bind）";
  return "workspace（宿主机直跑，无文件系统隔离）";
}

function hostPlatform(mode: "macos-seatbelt" | "linux-bubblewrap" | "workspace"): string {
  if (mode === "macos-seatbelt") return "darwin";
  if (mode === "linux-bubblewrap") return "linux";
  return process.platform;
}

function defaultPlatform(os: string): string {
  const name = os === "darwin" ? "macOS" : os === "linux" ? "Linux" : os;
  return `${name} ${process.arch}`;
}

async function probeExecutorTools(
  input: ExecutorEnvironmentFactsInput,
  probe?: ExecutorToolProbe
): Promise<string[]> {
  if (probe) {
    try {
      return await probe(EXECUTOR_TOOL_PROBE_LIST);
    } catch {
      return [];
    }
  }
  if (input.mode === "docker") {
    const image = input.image ?? "luanniao-executor:latest";
    return inspectDockerImageTools(image);
  }
  hostToolCache ??= runToolProbe("sh", ["-c", probeShellLoop()]);
  return hostToolCache;
}

async function inspectDockerImageTools(image: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("docker", ["image", "inspect", "--format", "{{json .}}", image], {
      timeout: TOOL_PROBE_TIMEOUT_MS
    });
    const inspected = JSON.parse(stdout) as {
      Id?: string;
      Config?: { Labels?: Record<string, string> };
    };
    const imageId = inspected.Id?.trim();
    if (!imageId) return [];
    let cached = dockerToolCache.get(imageId);
    if (!cached) {
      cached = Promise.resolve().then(() => {
        const raw = inspected.Config?.Labels?.[EXECUTOR_FACTS_LABEL];
        if (!raw) return [];
        const facts = JSON.parse(raw) as { version?: unknown; uid?: unknown; rawSockets?: unknown; tools?: unknown };
        if (facts.version !== 1 || facts.uid !== 1000 || facts.rawSockets !== false || !Array.isArray(facts.tools)) {
          return [];
        }
        return facts.tools.filter((tool): tool is string => typeof tool === "string");
      }).catch(() => []);
      dockerToolCache.set(imageId, cached);
    }
    return cached;
  } catch {
    return [];
  }
}

function probeShellLoop(): string {
  return `for t in ${EXECUTOR_TOOL_PROBE_LIST.join(" ")}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done`;
}

async function runToolProbe(command: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: TOOL_PROBE_TIMEOUT_MS });
    const found = new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    return EXECUTOR_TOOL_PROBE_LIST.filter((name) => found.has(name));
  } catch {
    // Probe failure silently omits the tool line; the facts block must still render.
    return [];
  }
}
