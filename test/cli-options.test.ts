import assert from "node:assert/strict";
import test from "node:test";
import { parseCliOptions, shouldUseTui } from "../src/cli-options.js";

test("uses TUI only for an interactive terminal without machine output flags", () => {
  const options = parseCliOptions(["--goal", "inspect", "--max-cycles", "3", "--proxy", "socks5://user:pass@proxy.test:1080"]);
  assert.equal(options.goal, "inspect");
  assert.equal(options.maxPlannerCycles, 3);
  assert.equal(options.scope, undefined);
  assert.equal(options.proxy, "socks5://user:pass@proxy.test:1080");
  assert.equal(shouldUseTui(options, { stdinIsTTY: true, stdoutIsTTY: true }), true);
  assert.equal(shouldUseTui(options, { stdinIsTTY: false, stdoutIsTTY: true }), false);
  assert.equal(shouldUseTui({ ...options, jsonl: true }, { stdinIsTTY: true, stdoutIsTTY: true }), false);
});

test("rejects missing and invalid numeric option values", () => {
  assert.throws(() => parseCliOptions(["--scope"]), /Missing value/);
  assert.throws(() => parseCliOptions(["--max-cycles", "many"]), /Invalid number/);
});

test("preserves repeated scope files and their explicit confirmation flag", () => {
  const options = parseCliOptions([
    "--scope-file", "first.txt",
    "--scope-file", "second.docx",
    "--confirm-scope-files",
    "--no-tui"
  ]);
  assert.deepEqual(options.scopeFiles, ["first.txt", "second.docx"]);
  assert.equal(options.confirmScopeFiles, true);
});

test("forbids scope files when resuming a stored runtime", () => {
  assert.throws(
    () => parseCliOptions(["--resume", "runtime-a", "--scope-file", "scope.txt"]),
    /--scope-file cannot be used with --resume/
  );
});
