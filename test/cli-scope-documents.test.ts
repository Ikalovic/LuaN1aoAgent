import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCliScopeDocuments } from "../src/cli-scope-documents.js";

test("merges repeated CLI scope files with manual scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-scope-files-"));
  await writeFile(join(root, "domains.txt"), "api.example");
  await writeFile(join(root, "networks.json"), JSON.stringify({ network: "10.0.0.0/24" }));

  const result = await resolveCliScopeDocuments({
    cwd: root,
    runtimeDir: join(root, "runtime"),
    files: ["domains.txt", "networks.json"],
    manualScope: "manual.example"
  });

  assert.equal(result.normalizedScope, "10.0.0.0/24,api.example,manual.example");
  assert.deepEqual(result.documents.map((document) => document.fileName), ["domains.txt", "networks.json"]);
});
