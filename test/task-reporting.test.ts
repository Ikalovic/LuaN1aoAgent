import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPentestTemplates, normalizeTaskType, reportFilename } from "../src/reporting/task-reporting.js";

test("missing task type defaults to pentest", () => {
  assert.equal(normalizeTaskType(undefined), "pentest");
  assert.equal(normalizeTaskType("ctf"), "ctf");
  assert.equal(reportFilename("ctf"), "writeup.md");
  assert.equal(reportFilename("pentest"), "pentest-report.md");
});

test("invalid task type is rejected", () => {
  assert.throws(() => normalizeTaskType("unknown"), /taskType/);
});

test("pentest templates load from explicit paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-reporting-"));
  const scoringPath = join(root, "scoring.md");
  const reportPath = join(root, "report.md");
  await writeFile(scoringPath, "# 评分标准\n");
  await writeFile(reportPath, "# 攻击路径\n");
  const result = await loadPentestTemplates({ scoringPath, reportPath, allowedRoots: [root] });
  assert.match(result.scoringText ?? "", /评分/);
  assert.match(result.reportText ?? "", /攻击路径/);
  assert.match(result.templateDigest ?? "", /^[a-f0-9]{64}$/);
});

test("empty or outside-root template fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-reporting-"));
  const outside = await mkdtemp(join(tmpdir(), "task-reporting-outside-"));
  const scoringPath = join(root, "scoring.md");
  const reportPath = join(root, "report.md");
  await writeFile(scoringPath, "");
  await writeFile(reportPath, "# report\n");
  await assert.rejects(loadPentestTemplates({ scoringPath, reportPath, allowedRoots: [root] }), (error: unknown) => (error as { code?: string }).code === "template_unavailable");
  const outsidePath = join(outside, "scoring.md");
  await writeFile(outsidePath, "# scoring\n");
  await assert.rejects(loadPentestTemplates({ scoringPath: outsidePath, reportPath, allowedRoots: [root] }), (error: unknown) => (error as { code?: string }).code === "template_unavailable");
});
