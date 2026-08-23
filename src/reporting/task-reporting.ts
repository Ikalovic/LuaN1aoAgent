import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type TaskType = "ctf" | "pentest";

export type ReportingContext = {
  taskType: TaskType;
  scoringTemplatePath?: string;
  reportTemplatePath?: string;
  scoringText?: string;
  reportText?: string;
  templateDigest?: string;
};

const MAX_TEMPLATE_BYTES = 128 * 1024;

export class ReportingTemplateError extends Error {
  readonly code = "template_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "ReportingTemplateError";
  }
}

export function normalizeTaskType(value: unknown): TaskType {
  if (value === undefined || value === null || value === "") return "pentest";
  if (value === "ctf" || value === "pentest") return value;
  throw new Error("taskType 必须是 ctf 或 pentest");
}

export function reportFilename(taskType: TaskType): string {
  return taskType === "ctf" ? "writeup.md" : "pentest-report.md";
}

export async function loadPentestTemplates(input: {
  scoringPath: string;
  reportPath: string;
  allowedRoots: string[];
}): Promise<ReportingContext> {
  const scoring = await readTemplate(input.scoringPath, input.allowedRoots, "评分标准");
  const report = await readTemplate(input.reportPath, input.allowedRoots, "报告模板");
  const digest = createHash("sha256").update(scoring.text).update("\0").update(report.text).digest("hex");
  return {
    taskType: "pentest",
    scoringTemplatePath: scoring.path,
    reportTemplatePath: report.path,
    scoringText: scoring.text,
    reportText: report.text,
    templateDigest: digest
  };
}

async function readTemplate(path: string, allowedRoots: string[], label: string): Promise<{ path: string; text: string }> {
  const resolved = resolve(path);
  const allowed = allowedRoots.some((root) => {
    const rootPath = resolve(root);
    const rel = relative(rootPath, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) throw new ReportingTemplateError(`${label}模板不在允许目录内`);
  try {
    const info = await stat(resolved);
    if (!info.isFile() || info.size === 0 || info.size > MAX_TEMPLATE_BYTES) {
      throw new ReportingTemplateError(`${label}模板为空、过大或不是文件`);
    }
    const text = await readFile(resolved, "utf8");
    if (!text.trim()) throw new ReportingTemplateError(`${label}模板为空`);
    return { path: resolved, text };
  } catch (error) {
    if (error instanceof ReportingTemplateError) throw error;
    throw new ReportingTemplateError(`${label}模板不可读: ${error instanceof Error ? error.message : String(error)}`);
  }
}
