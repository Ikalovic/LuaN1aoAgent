import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CliOptions } from "./cli-options.js";
import { readStoredRunIdentity } from "./runtime-identity.js";

export type CliRunContext = {
  runtimeDir: string;
  userGoal: string;
  scopeSummary?: string;
  resumed: boolean;
};

export function resolveCliRunContext(
  options: CliOptions,
  cwd: string,
  input: { now?: Date; uniqueId?: string } = {}
): CliRunContext {
  if (options.resumeDir) {
    const runtimeDir = resolveResumeRuntime(cwd, options.resumeDir);
    const stored = readStoredRunIdentity(runtimeDir);
    if (!stored.userGoal) {
      throw new Error(`Cannot resume ${runtimeDir}: the session has no stored Root Goal`);
    }
    if (!stored.scopeSummary) {
      throw new Error(`Cannot resume ${runtimeDir}: the session has no stored authorized scope`);
    }
    return {
      runtimeDir,
      userGoal: stored.userGoal,
      scopeSummary: stored.scopeSummary,
      resumed: true
    };
  }

  if (options.runtimeDir) {
    const runtimeDir = absolutePath(cwd, options.runtimeDir);
    assertFreshRuntimeDir(runtimeDir);
    return { runtimeDir, userGoal: options.goal, scopeSummary: options.scope, resumed: false };
  }

  const timestamp = formatTimestamp(input.now ?? new Date());
  const uniqueId = input.uniqueId ?? randomUUID().slice(0, 8);
  const runtimeDir = join(cwd, ".agent-runtime", "sessions", `${timestamp}-${uniqueId}`);
  assertFreshRuntimeDir(runtimeDir);
  return { runtimeDir, userGoal: options.goal, scopeSummary: options.scope, resumed: false };
}

function assertFreshRuntimeDir(runtimeDir: string): void {
  if (existsSync(runtimeDir) && readdirSync(runtimeDir).length > 0) {
    throw new Error(
      `Runtime directory already contains state: ${runtimeDir}. ` +
      "Use --resume to continue it or choose a new --runtime-dir."
    );
  }
}

function absolutePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function resolveResumeRuntime(cwd: string, value: string): string {
  const directPath = absolutePath(cwd, value);
  if (existsSync(join(directPath, "state.sqlite"))) {
    return directPath;
  }
  const sessionPath = join(cwd, ".agent-runtime", "sessions", value);
  return existsSync(join(sessionPath, "state.sqlite")) ? sessionPath : directPath;
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

