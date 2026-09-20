import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ATTACHMENT_LIMITS,
  AttachmentStore,
  attachmentExtension,
  inferMediaType,
  normalizeFileName
} from "../src/attachments/attachment-store.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<AttachmentStore> {
  const root = await mkdtemp(join(tmpdir(), "ln-attachments-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return new AttachmentStore(join(root, "attachments"));
}

test("staged attachments round-trip bytes and metadata", async (t) => {
  const store = await fixture(t);
  const data = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

  const stored = await store.put({ fileName: "chall.elf", data });
  assert.equal(stored.fileName, "chall.elf");
  assert.equal(stored.mediaType, "application/x-elf");
  assert.equal(stored.byteLength, data.byteLength);
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);
  assert.match(stored.attachmentId, /^[0-9a-f-]{36}$/);

  assert.deepEqual(await store.get(stored.attachmentId), stored);
  assert.deepEqual(await store.read(stored.attachmentId), data);
});

test("binary attachments survive the staging round trip unchanged", async (t) => {
  const store = await fixture(t);
  // A NUL byte and invalid UTF-8: attachments are bytes, not text.
  const data = Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x0a, 0x0d]);
  const stored = await store.put({ fileName: "dump.bin", data });
  assert.deepEqual(await store.read(stored.attachmentId), data);
});

test("discarding a staged attachment removes it, and is idempotent", async (t) => {
  const store = await fixture(t);
  const stored = await store.put({ fileName: "notes.txt", data: Buffer.from("hello") });

  assert.equal(await store.discard(stored.attachmentId), true);
  assert.equal(await store.get(stored.attachmentId), undefined);
  assert.equal(await store.discard(stored.attachmentId), false);
});

test("attachment ids cannot escape the staging root", async (t) => {
  const store = await fixture(t);
  for (const id of ["../../etc/passwd", "..", "", "not-a-uuid", `${"a".repeat(8)}-../../x`]) {
    await assert.rejects(() => store.get(id), /Invalid attachment id/);
    await assert.rejects(() => store.read(id), /Invalid attachment id/);
    await assert.rejects(() => store.discard(id), /Invalid attachment id/);
  }
});

test("file names are metadata, so only bare names are accepted", () => {
  assert.equal(normalizeFileName("  report.pdf  "), "report.pdf");
  assert.equal(normalizeFileName("题 目.zip"), "题 目.zip");
  // A name is written into prompts and the artifact record; separators and
  // control characters would be an injection surface there.
  for (const name of ["../escape.txt", "a/b.txt", "a\\b.txt", "a\u0000b", "a\nb", ".", "..", ""]) {
    assert.throws(() => normalizeFileName(name), /附件名/, `must reject ${JSON.stringify(name)}`);
  }
  assert.throws(() => normalizeFileName("x".repeat(ATTACHMENT_LIMITS.fileNameLength + 1)), /附件名/);
});

test("media type and artifact extension are derived from the name", () => {
  assert.equal(inferMediaType("chall.zip"), "application/zip");
  assert.equal(inferMediaType("capture.pcap"), "application/vnd.tcpdump.pcap");
  assert.equal(inferMediaType("UPPER.PDF"), "application/pdf");
  assert.equal(inferMediaType("noextension"), "application/octet-stream");
  assert.equal(inferMediaType("weird.zzz"), "application/octet-stream");

  // The artifact store validates extensions strictly and throws otherwise, so
  // anything unusual has to degrade to `bin` instead of failing the upload.
  assert.equal(attachmentExtension("chall.elf"), "elf");
  assert.equal(attachmentExtension("archive.tar.gz"), "gz");
  assert.equal(attachmentExtension("noextension"), "bin");
  assert.equal(attachmentExtension("weird.zzz"), "zzz");
  assert.equal(attachmentExtension(".hidden"), "bin");
  assert.equal(attachmentExtension("toolong." + "x".repeat(20)), "bin");
  assert.equal(attachmentExtension("dash.-leading"), "bin");
});

test("the staged file on disk is private and named by id, never by the uploaded name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ln-attachments-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new AttachmentStore(join(root, "attachments"));

  const stored = await store.put({ fileName: "../../evil.sh", data: Buffer.from("x") }).catch((error: Error) => error);
  assert.ok(stored instanceof Error, "path-shaped names are rejected at the store boundary");

  const safe = await store.put({ fileName: "evil.sh", data: Buffer.from("x") });
  const meta = JSON.parse(await readFile(join(root, "attachments", safe.attachmentId, "meta.json"), "utf8")) as { fileName: string };
  assert.equal(meta.fileName, "evil.sh");
  // The bytes live under the generated id, so the uploaded name never becomes a path.
  const bytes = await readFile(join(root, "attachments", safe.attachmentId, "source.bin"), "utf8");
  assert.equal(bytes, "x");
});

test("a symlinked staging directory is not followed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ln-attachments-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new AttachmentStore(join(root, "attachments"));

  // A directory planted in place of a staged attachment must not be read
  // through, even when it is named like a valid id and holds a matching file.
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "meta.json"), JSON.stringify({ attachmentId: "forged" }));
  const forgedId = "11111111-1111-4111-8111-111111111111";
  await mkdir(join(root, "attachments"), { recursive: true });
  await symlink(outside, join(root, "attachments", forgedId));

  assert.equal(await store.get(forgedId), undefined);
});


test("the Web client advertises exactly the limits the server enforces", () => {
  // The client checks size and count before uploading so the operator gets an
  // immediate message instead of a rejected request. Those constants are a
  // second copy of ATTACHMENT_LIMITS, so they must not drift.
  const client = readFileSync(join(process.cwd(), "web", "src", "components", "StartRunModal.tsx"), "utf8");
  const megabytes = ATTACHMENT_LIMITS.inputBytes / (1024 * 1024);
  assert.ok(
    client.includes(`const ATTACHMENT_MAX_BYTES = ${megabytes} * 1024 * 1024;`),
    `StartRunModal must cap uploads at ${megabytes} MiB to match the server`
  );
  assert.ok(
    client.includes(`const ATTACHMENT_MAX_FILES = ${ATTACHMENT_LIMITS.filesPerRun};`),
    `StartRunModal must cap the file count at ${ATTACHMENT_LIMITS.filesPerRun} to match the server`
  );
});
