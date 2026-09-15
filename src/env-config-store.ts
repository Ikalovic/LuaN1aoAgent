import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type EnvConfigEntry = {
  key: string;
  sensitive: boolean;
  /** Present for non-sensitive entries; sensitive values never leave the server. */
  value?: string;
  /** Masked preview for sensitive entries, e.g. "••••abcd". */
  preview?: string;
};

export type EnvConfigView = {
  path: string;
  entries: EnvConfigEntry[];
  updatedAt: string | null;
};

export type EnvConfigChanges = {
  set?: Record<string, string>;
  remove?: string[];
};

export type EnvConfigStoreOptions = {
  cwd: string;
  envPath?: string;
  environment?: NodeJS.ProcessEnv;
};

export class EnvConfigInputError extends Error {}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL)/i;
const SENSITIVE_EXACT = new Set(["DSN"]);
// Child processes rely on these; rewriting them in the running server would
// break later spawns, so they are rejected even for administrators.
const PROTECTED_KEYS = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "WINDIR"]);
const MAX_VALUE_LENGTH = 4096;
const MAX_CHANGES = 100;

/**
 * Reads and rewrites the project .env file on behalf of the web workbench.
 * Writes update the live process environment as well, so registries sharing
 * process.env (for example McpRegistry) observe the change on their next scan.
 * Values are never echoed back in full: sensitive keys are masked in views.
 */
export class EnvConfigStore {
  private readonly envPath: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: EnvConfigStoreOptions) {
    this.envPath = options.envPath ?? join(options.cwd, ".env");
    this.environment = options.environment ?? process.env;
  }

  view(): EnvConfigView {
    const text = this.readText();
    const entries: EnvConfigEntry[] = [];
    if (text !== undefined) {
      for (const entry of parseEnvEntries(text)) {
        if (isSensitiveKey(entry.key)) {
          entries.push({ key: entry.key, sensitive: true, preview: maskValue(entry.value) });
        } else {
          entries.push({ key: entry.key, sensitive: false, value: entry.value });
        }
      }
    }
    let updatedAt: string | null = null;
    if (text !== undefined) {
      try {
        updatedAt = statSync(this.envPath).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }
    return { path: this.envPath, entries, updatedAt };
  }

  applyChanges(changes: EnvConfigChanges): EnvConfigView {
    const set = normalizeSet(changes.set);
    const remove = normalizeRemove(changes.remove);
    for (const key of remove) {
      if (Object.hasOwn(set, key)) throw new EnvConfigInputError(`变量不能同时设置与删除: ${key}`);
    }
    if (Object.keys(set).length + remove.length > MAX_CHANGES) {
      throw new EnvConfigInputError(`单次最多修改 ${MAX_CHANGES} 个变量`);
    }

    const original = this.readText() ?? "";
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const lines = original.replace(/\r?\n$/, "") === "" ? [] : original.replace(/\r?\n$/, "").split(/\r?\n/);
    const rendered = new Map(Object.entries(set).map(([key, value]) => [key, `${key}=${renderValue(value)}`]));
    const removeSet = new Set(remove);
    const written = new Set<string>();
    const output: string[] = [];
    for (const line of lines) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      const key = match?.[1];
      if (key !== undefined) {
        if (removeSet.has(key)) continue;
        const replacement = rendered.get(key);
        if (replacement !== undefined) {
          output.push(replacement);
          written.add(key);
          continue;
        }
      }
      output.push(line);
    }
    for (const [key, line] of rendered) {
      if (!written.has(key)) output.push(line);
    }
    const nextText = output.length ? `${output.join(eol)}${eol}` : "";

    mkdirSync(dirname(this.envPath), { recursive: true });
    const temporary = `${this.envPath}.${process.pid}.tmp`;
    writeFileSync(temporary, nextText, { mode: 0o600 });
    renameSync(temporary, this.envPath);

    for (const [key, value] of Object.entries(set)) {
      this.environment[key] = value;
    }
    for (const key of remove) {
      delete this.environment[key];
    }
    return this.view();
  }

  private readText(): string | undefined {
    try {
      return readFileSync(this.envPath, "utf8");
    } catch {
      return undefined;
    }
  }
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERN.test(key) || SENSITIVE_EXACT.has(key.toUpperCase());
}

function parseEnvEntries(text: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!KEY_PATTERN.test(key)) continue;
    entries.push({ key, value: unquote(line.slice(separatorIndex + 1).trim()) });
  }
  return entries;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function maskValue(value: string): string {
  if (!value) return "";
  return value.length >= 8 ? `••••${value.slice(-4)}` : "••••";
}

/**
 * Quote values that would otherwise round-trip incorrectly: the loader strips
 * one pair of surrounding quotes, so a value that starts or ends with a quote
 * must be wrapped, and "#" is quoted defensively for editors that treat it as
 * a comment marker.
 */
function renderValue(value: string): string {
  return /^["']|["']$/.test(value) || value.includes("#") ? `"${value}"` : value;
}

function normalizeSet(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnvConfigInputError("set 必须是键值对象");
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    assertKey(key);
    if (typeof raw !== "string") throw new EnvConfigInputError(`变量 ${key} 的值必须是字符串`);
    const value = raw.trim();
    if (!value) throw new EnvConfigInputError(`变量 ${key} 的值不能为空`);
    if (/[\r\n\0]/.test(value) || value.length > MAX_VALUE_LENGTH) {
      throw new EnvConfigInputError(`变量 ${key} 的值包含非法字符或过长`);
    }
    result[key] = value;
  }
  return result;
}

function normalizeRemove(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new EnvConfigInputError("remove 必须是数组");
  const result: string[] = [];
  for (const key of input) {
    if (typeof key !== "string") throw new EnvConfigInputError("remove 的元素必须是字符串");
    assertKey(key);
    if (!result.includes(key)) result.push(key);
  }
  return result;
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new EnvConfigInputError(`变量名无效: ${key}`);
  if (PROTECTED_KEYS.has(key.toUpperCase())) {
    throw new EnvConfigInputError(`不允许修改系统关键变量: ${key}`);
  }
}

