import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { createArtifactReadTool, createArtifactWriteTool } from "../src/tools/pi-tools.js";

test("writes artifacts and reads them by artifact ref", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const record = await artifactStore.write({
    taskId: "task:artifact",
    kind: "text",
    mediaType: "text/plain",
    data: "hello artifact"
  });

  assert.equal(await artifactStore.read(record.artifactRef), "hello artifact");
  assert.equal((await artifactStore.get(record.artifactRef))?.path, record.path);
});

test("lists artifacts by task id", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const firstRecord = await artifactStore.write({
    taskId: "task:list",
    kind: "text",
    mediaType: "text/plain",
    data: "first"
  });
  await artifactStore.write({
    taskId: "task:other",
    kind: "text",
    mediaType: "text/plain",
    data: "second"
  });

  const records = await artifactStore.list({ taskId: "task:list" });

  assert.deepEqual(records.map((record) => record.artifactRef), [firstRecord.artifactRef]);
});

test("deduplicates identical task artifacts and searches relevant chunks", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const content = `${"prefix ".repeat(400)}FLAG{indexed_chunk_hit}`;
  const first = await artifactStore.write({
    taskId: "task:search",
    kind: "text",
    mediaType: "text/plain",
    data: content
  });
  const duplicate = await artifactStore.write({
    taskId: "task:search",
    kind: "text",
    mediaType: "text/plain",
    data: content
  });

  assert.equal(duplicate.artifactRef, first.artifactRef);
  assert.equal((await artifactStore.list({ taskId: "task:search" })).length, 1);
  const matches = await artifactStore.search({ taskId: "task:search", query: "indexed chunk hit" });
  assert.equal(matches[0]?.artifactRef, first.artifactRef);
  assert.match(matches[0]?.snippet ?? "", /indexed_chunk_hit/);
});

test("searches only the artifact refs attached to the current projection batch", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const relevant = await artifactStore.write({
    taskId: "task:search",
    kind: "http_body",
    mediaType: "text/plain",
    data: "upload response FLAG{projection_ref_only}"
  });
  const unrelated = await artifactStore.write({
    taskId: "task:search",
    kind: "text",
    mediaType: "text/plain",
    data: "skill prompt FLAG{unrelated_context}"
  });

  const matches = await artifactStore.searchWithin({
    artifactRefs: [relevant.artifactRef],
    query: "FLAG projection",
    limit: 4
  });

  assert.ok(matches.some((match) => match.artifactRef === relevant.artifactRef));
  assert.equal(matches.some((match) => match.artifactRef === unrelated.artifactRef), false);
});

test("reports artifact count, bytes and kind distribution", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  await artifactStore.write({
    taskId: "task:stats",
    kind: "text",
    mediaType: "text/plain",
    data: "hello"
  });
  await artifactStore.write({
    taskId: "task:stats",
    kind: "http_body",
    mediaType: "text/plain",
    data: "response"
  });

  assert.deepEqual(artifactStore.stats(), {
    count: 2,
    byteLength: 13,
    uniqueContentCount: 2,
    byKind: {
      http_body: { count: 1, byteLength: 8 },
      text: { count: 1, byteLength: 5 }
    }
  });
});

test("artifact_read explicitly materializes complete binary artifacts into the Executor workspace", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-materialize-"));
  const workspaceDir = join(runtimeDir, "workspace");
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const bytes = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
  const record = await artifactStore.write({
    taskId: "task:producer",
    kind: "other",
    mediaType: "application/octet-stream",
    data: bytes,
    extension: "bin"
  });
  const tool = createArtifactReadTool(artifactStore, {
    workspace: { hostDir: workspaceDir, visibleRoot: "/workspace", sharedWithContainer: true }
  });

  const result = await tool.execute(
    "call:materialize",
    { path: record.artifactRef, materialize: true },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const materialized = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}") as {
    artifactRef: string;
    path: string;
  };

  assert.equal(materialized.artifactRef, record.artifactRef);
  assert.equal(materialized.path, `/workspace/.artifacts/${record.contentHash}.bin`);
  const materializedHostPath = join(workspaceDir, ".artifacts", `${record.contentHash}.bin`);
  assert.deepEqual(readFileSync(materializedHostPath), bytes);
  assert.equal(statSync(join(workspaceDir, ".artifacts")).mode & 0o777, 0o755);
  assert.equal(statSync(materializedHostPath).mode & 0o777, 0o644);
  await assert.rejects(
    () => tool.execute(
      "call:host-path",
      { path: record.path },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /requires a real artifactRef/
  );
  artifactStore.close();
});

test("artifact materialization rejects a workspace artifact-directory symlink", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-materialize-"));
  const workspaceDir = join(runtimeDir, "workspace");
  const outsideDir = join(runtimeDir, "outside");
  mkdirSync(workspaceDir);
  mkdirSync(outsideDir);
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const record = await artifactStore.write({
    kind: "text",
    mediaType: "text/plain",
    data: "do not escape"
  });
  symlinkSync(outsideDir, join(workspaceDir, ".artifacts"), "dir");
  const tool = createArtifactReadTool(artifactStore, {
    workspace: { hostDir: workspaceDir, visibleRoot: "/workspace" }
  });

  await assert.rejects(
    () => tool.execute(
      "call:materialize",
      { path: record.artifactRef, materialize: true },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /must be a real directory/
  );
  artifactStore.close();
});

test("artifact_write imports a complete workspace file without exposing its host path", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-import-"));
  const workspaceDir = join(runtimeDir, "workspace");
  mkdirSync(workspaceDir);
  const sourcePath = join(workspaceDir, "bundle.js");
  const source = `const marker = "${"complete-bundle-".repeat(20)}";`;
  writeFileSync(sourcePath, source);
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const tool = createArtifactWriteTool(artifactStore, {
    workspace: { hostDir: workspaceDir, visibleRoot: "/workspace" }
  });

  const result = await tool.execute(
    "call:import",
    {
      source: { type: "file", path: "/workspace/bundle.js" },
      kind: "text",
      mediaType: "application/javascript"
    },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
  const publicRecord = JSON.parse(text) as { artifactRef: string; byteLength: number; path?: string };

  assert.equal(publicRecord.byteLength, Buffer.byteLength(source));
  assert.equal(publicRecord.path, undefined);
  assert.doesNotMatch(text, new RegExp(runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await artifactStore.read(publicRecord.artifactRef), source);
  artifactStore.close();
});

test("artifact_write schema infers the source type and tolerates omitted discriminators", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-schema-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const schema = createArtifactWriteTool(artifactStore).parameters;
  const common = { kind: "text", mediaType: "text/plain" };

  assert.equal(Check(schema, { ...common, source: { type: "inline", data: "evidence" } }), true);
  assert.equal(Check(schema, { ...common, source: { type: "file", path: "/workspace/evidence.txt" } }), true);
  assert.equal(Check(schema, { ...common, source: { data: "evidence" } }), true);
  assert.equal(Check(schema, { ...common, source: { path: "/workspace/evidence.txt" } }), true);
  assert.equal(Check(schema, { ...common, source: { type: "unknown", data: "evidence" } }), false);
  assert.equal(Check(schema, { ...common, data: "legacy", path: "/workspace/evidence.txt" }), false);

  const tool = createArtifactWriteTool(artifactStore);
  const execute = (source: Record<string, unknown>) => tool.execute(
    "call:infer",
    { ...common, source },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const inferredInline = await execute({ data: "inferred inline payload" });
  const inlineText = inferredInline.content[0]?.type === "text" ? inferredInline.content[0].text : "{}";
  assert.equal((JSON.parse(inlineText) as { byteLength: number }).byteLength, Buffer.byteLength("inferred inline payload"));
  await assert.rejects(
    execute({ type: "file", path: "/workspace/evidence.txt", data: "ambiguous" }),
    /file source requires exactly path \(no data\)/
  );
  await assert.rejects(
    execute({ type: "inline", path: "/workspace/evidence.txt", data: "ambiguous" }),
    /inline source requires exactly data \(no path\)/
  );
  artifactStore.close();
});

test("artifact extension normalization accepts file names and keeps the final suffix", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-ext-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const named = await artifactStore.write({
    kind: "text",
    mediaType: "text/markdown",
    data: "# recon",
    extension: "recon.md"
  });
  assert.match(named.path, /\.md$/);
  const dotted = await artifactStore.write({
    kind: "text",
    mediaType: "application/json",
    data: "{}",
    extension: ".json"
  });
  assert.match(dotted.path, /\.json$/);
  await assert.rejects(
    artifactStore.write({ kind: "text", mediaType: "text/plain", data: "x", extension: "not an extension!" }),
    /Invalid artifact extension/
  );
  artifactStore.close();
});

test("artifact_write imports sandbox files through the sandbox-owned reader", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-sandbox-"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const reads: string[] = [];
  const tool = createArtifactWriteTool(artifactStore, {
    readExecutorFile: async (visiblePath) => {
      reads.push(visiblePath);
      if (visiblePath === "/tmp/evidence.txt") return Buffer.from("tmp-evidence-bytes");
      throw new Error(`Executor file source does not exist: ${visiblePath}`);
    }
  });
  const execute = (path: string) => tool.execute(
    `call:sandbox:${path}`,
    { source: { type: "file", path }, kind: "text", mediaType: "text/plain" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );

  const first = await execute("/tmp/evidence.txt");
  const firstRecord = JSON.parse(first.content[0]?.type === "text" ? first.content[0].text : "{}") as {
    artifactRef: string;
    byteLength: number;
  };
  assert.equal(firstRecord.byteLength, Buffer.byteLength("tmp-evidence-bytes"));
  assert.equal(await artifactStore.read(firstRecord.artifactRef), "tmp-evidence-bytes");

  const second = await execute("/tmp/evidence.txt");
  const secondRecord = JSON.parse(second.content[0]?.type === "text" ? second.content[0].text : "{}") as {
    artifactRef: string;
  };
  assert.equal(secondRecord.artifactRef, firstRecord.artifactRef, "identical content deduplicates by hash");

  await assert.rejects(() => execute("/tmp/missing.txt"), /does not exist/);
  assert.deepEqual(reads, ["/tmp/evidence.txt", "/tmp/evidence.txt", "/tmp/missing.txt"]);
  artifactStore.close();
});

test("artifact_write rejects files outside or symlinked from the Executor workspace", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-artifact-import-"));
  const workspaceDir = join(runtimeDir, "workspace");
  mkdirSync(workspaceDir);
  const outsidePath = join(runtimeDir, "outside.txt");
  writeFileSync(outsidePath, "outside");
  symlinkSync(outsidePath, join(workspaceDir, "linked.txt"));
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"));
  const tool = createArtifactWriteTool(artifactStore, {
    workspace: { hostDir: workspaceDir, visibleRoot: "/workspace" }
  });
  const execute = (path: string) => tool.execute(
    `call:reject:${path}`,
    { source: { type: "file", path }, kind: "text", mediaType: "text/plain" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );

  await assert.rejects(() => execute("/outside.txt"), /outside the Executor workspace/);
  await assert.rejects(() => execute("/workspace/linked.txt"), /regular workspace file/);
  artifactStore.close();
});
