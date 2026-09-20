import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Operator-provided task attachments (a CTF challenge binary, a pcap, a vendor
 * advisory, a config dump, a credential export) staged before a run starts.
 *
 * Staging exists so the Web UI can upload, list and remove files independently
 * of the run: `POST /api/runs` then only carries attachment ids, which keeps the
 * run request small and lets the operator retry a start without re-uploading.
 * On start, each staged file is copied into the run's ArtifactStore, which is
 * what the Planner and Executor actually reference.
 *
 * The store is deliberately dumb about content: attachments are arbitrary bytes
 * by nature, so there is no type allowlist, only size, count and name hygiene.
 * Uploading is an operator-mutate capability, and the bytes are treated as
 * untrusted input by the agents that later read them.
 */
export type StoredAttachment = {
  attachmentId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
};

export const ATTACHMENT_LIMITS = {
  /** Per-file cap. CTF binaries and pcaps fit; a 100 MiB disk image does not. */
  inputBytes: 32 * 1024 * 1024,
  /** Per-run cap, applied when starting a run rather than while staging. */
  filesPerRun: 12,
  fileNameLength: 200
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AttachmentStore {
  constructor(readonly rootDir: string) {}

  async put(input: { fileName: string; data: Buffer }): Promise<StoredAttachment> {
    const fileName = normalizeFileName(input.fileName);
    const attachmentId = randomUUID();
    const createdAt = new Date().toISOString();
    const record: StoredAttachment = {
      attachmentId,
      fileName,
      mediaType: inferMediaType(fileName),
      byteLength: input.data.byteLength,
      sha256: createHash("sha256").update(input.data).digest("hex"),
      createdAt
    };
    const directory = this.attachmentDir(attachmentId);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    await Promise.all([
      writeFile(join(directory, "source.bin"), input.data, { mode: 0o600 }),
      writeFile(join(directory, "meta.json"), JSON.stringify(record, null, 2), { mode: 0o600 })
    ]);
    return record;
  }

  async get(attachmentId: string): Promise<StoredAttachment | undefined> {
    const directory = this.attachmentDir(attachmentId);
    try {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
      return JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as StoredAttachment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async read(attachmentId: string): Promise<Buffer> {
    return await readFile(join(this.attachmentDir(attachmentId), "source.bin"));
  }

  /** Removes a staged upload the operator deleted before starting the run. */
  async discard(attachmentId: string): Promise<boolean> {
    const directory = this.attachmentDir(attachmentId);
    if (!await this.get(attachmentId)) return false;
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  private attachmentDir(attachmentId: string): string {
    if (!UUID_PATTERN.test(attachmentId)) throw new Error("Invalid attachment id");
    const root = resolve(this.rootDir);
    const candidate = resolve(root, attachmentId);
    if (!candidate.startsWith(`${root}${sep}`)) throw new Error("Attachment path escapes its root");
    return candidate;
  }
}

/**
 * Rejects anything that is not a bare file name. Attachments are written to disk
 * under a generated id, so this is about honest metadata (and about refusing
 * names the Web UI cannot display), not about path containment.
 */
export function normalizeFileName(value: string): string {
  const fileName = value.trim();
  if (!fileName || fileName.length > ATTACHMENT_LIMITS.fileNameLength) {
    throw new Error("附件名无效");
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(fileName) || fileName === "." || fileName === "..") {
    throw new Error("附件名不能包含路径分隔符或控制字符");
  }
  return fileName;
}

/**
 * Suffix used for the stored artifact file. The artifact store validates
 * extensions strictly and throws on anything else, so an unknown or absent
 * suffix degrades to `bin` rather than failing the upload.
 */
export function attachmentExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const candidate = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9][a-z0-9_-]{0,15}$/.test(candidate) ? candidate : "bin";
}

const MEDIA_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  log: "text/plain",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  tgz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  pcap: "application/vnd.tcpdump.pcap",
  pcapng: "application/vnd.tcpdump.pcap",
  bin: "application/octet-stream",
  elf: "application/x-elf",
  exe: "application/vnd.microsoft.portable-executable",
  so: "application/x-sharedlib",
  py: "text/x-python",
  sh: "text/x-shellscript",
  js: "text/javascript",
  php: "text/x-php",
  sql: "application/sql",
  pem: "application/x-pem-file",
  key: "application/x-pem-file",
  crt: "application/x-x509-ca-cert",
  db: "application/vnd.sqlite3",
  sqlite: "application/vnd.sqlite3",
  har: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

/**
 * Media type from the file name only. A client-supplied type would be trivially
 * spoofable and is only ever used for display and for the Planner's metadata, so
 * it is derived here instead of trusted from the request.
 */
export function inferMediaType(fileName: string): string {
  return MEDIA_TYPES[attachmentExtension(fileName)] ?? "application/octet-stream";
}
