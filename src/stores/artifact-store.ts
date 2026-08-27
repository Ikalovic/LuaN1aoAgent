import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, chmod, link, lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toJsonLine } from "../json.js";
import type { ArtifactRecord, CredentialIndexRecord, CredentialAccessLogRecord } from "../types.js";

type ArtifactRow = {
  artifact_ref: string;
  task_id: string | null;
  kind: ArtifactRecord["kind"];
  media_type: string;
  path: string;
  byte_length: number;
  created_at: string;
  preview: string;
  content_hash: string;
};

export class ArtifactStore {
  readonly rootDir: string;
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(rootDir: string, databasePath = join(dirname(rootDir), "state.sqlite")) {
    this.rootDir = rootDir;
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
    this.importLegacyIndex();
  }

  close(): void {
    this.database.close();
  }

  async write(input: {
    taskId?: string;
    kind: ArtifactRecord["kind"];
    mediaType: string;
    data: string | Buffer;
    extension?: string;
  }): Promise<ArtifactRecord> {
    if (input.kind === "credential") throw new Error("Credential artifacts require writeCredential");
    const dataBuffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const contentHash = createHash("sha256").update(dataBuffer).digest("hex");
    const existing = this.database.prepare(`
      SELECT * FROM artifacts
      WHERE task_id IS ? AND content_hash = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(input.taskId ?? null, contentHash) as ArtifactRow | undefined;
    if (existing) {
      return rowToRecord(existing);
    }

    const createdAt = new Date().toISOString();
    const artifactRef = `artifact:${randomUUID()}`;
    const extension = normalizeExtension(input.extension ?? extensionForKind(input.kind));
    const relativePath = join(input.taskId ?? "global", `${contentHash}.${extension}`);
    const absolutePath = join(this.rootDir, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    if (!existsSync(absolutePath)) {
      await writeFile(absolutePath, dataBuffer);
    }
    const record: ArtifactRecord = {
      artifactRef,
      taskId: input.taskId,
      kind: input.kind,
      mediaType: input.mediaType,
      path: absolutePath,
      byteLength: dataBuffer.byteLength,
      createdAt,
      preview: dataBuffer.toString("utf8", 0, Math.min(dataBuffer.byteLength, 800)),
      contentHash
    };
    const inserted = this.insertRecord(record, dataBuffer.toString("utf8"));
    if (!inserted) {
      const concurrent = this.database.prepare(`
        SELECT * FROM artifacts WHERE task_id IS ? AND content_hash = ? ORDER BY created_at DESC LIMIT 1
      `).get(input.taskId ?? null, contentHash) as ArtifactRow | undefined;
      if (concurrent) {
        return rowToRecord(concurrent);
      }
    }
    await this.appendRecord(record);
    return record;
  }

  async writeCredential(input: {
    data: string | Buffer;
    scopeRef?: string;
    kind?: string;
    hostRef?: string;
    label?: string;
    username?: string;
    role?: string;
    source?: string;
  }): Promise<ArtifactRecord> {
    const dataBuffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    if (dataBuffer.byteLength === 0 || dataBuffer.byteLength > 1 << 20) {
      throw new Error("Credential is empty or too large");
    }
    const createdAt = new Date().toISOString();
    const artifactRef = `artifact:${randomUUID()}`;
    const randomName = `${randomUUID()}.secret`;
    const absolutePath = join(this.rootDir, "credentials", randomName);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, dataBuffer, { flag: "wx", mode: 0o600 });
    await chmod(absolutePath, 0o600);
    const record: ArtifactRecord = {
      artifactRef,
      kind: "credential",
      mediaType: "application/vnd.luanniao.credential",
      path: absolutePath,
      byteLength: dataBuffer.byteLength,
      createdAt,
      preview: "[sensitive credential]",
      contentHash: `sensitive:${randomUUID()}`
    };
    if (!this.insertRecord(record, "")) {
      await unlink(absolutePath).catch(() => undefined);
      throw new Error("Failed to persist credential artifact");
    }
    await this.appendRecord(record);
    if (input.scopeRef) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare(`
          INSERT OR REPLACE INTO credential_index
            (artifact_ref, scope_ref, kind, host_ref, label, username, role, source, valid, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          record.artifactRef,
          input.scopeRef,
          input.kind ?? "other",
          input.hostRef ?? null,
          input.label ?? "",
          input.username ?? null,
          input.role ?? null,
          input.source ?? "auto_output",
          record.createdAt
        );
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    return record;
  }

  async listCredentials(scopeRef: string, options?: {
    hostRef?: string;
    kind?: string;
    role?: string;
    validOnly?: boolean;
  }): Promise<CredentialIndexRecord[]> {
    const conditions: string[] = ["scope_ref = ?"];
    const params: string[] = [scopeRef];
    if (options?.hostRef) {
      conditions.push("host_ref = ?");
      params.push(options.hostRef);
    }
    if (options?.kind) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    if (options?.role) {
      conditions.push("role = ?");
      params.push(options.role);
    }
    if (options?.validOnly) {
      conditions.push("valid = 1");
    }
    const sql = `SELECT * FROM credential_index WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`;
    const rows = this.database.prepare(sql).all(...params) as CredentialIndexRow[];
    return rows.map(credentialRowToRecord);
  }

  async readCredential(artifactRef: string): Promise<string> {
    return this.read(artifactRef);
  }

  async invalidateCredential(artifactRef: string): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE credential_index SET valid = 0 WHERE artifact_ref = ?").run(artifactRef);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async touchCredential(artifactRef: string): Promise<void> {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE credential_index SET last_used_at = ? WHERE artifact_ref = ?").run(now, artifactRef);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async logCredentialAccess(input: {
    credentialRef: string;
    taskId?: string;
    action: string;
    actor: string;
    details?: string;
  }): Promise<void> {
    const id = `credlog:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO credential_access_log (id, credential_ref, task_id, action, actor, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.credentialRef, input.taskId ?? null, input.action, input.actor, input.details ?? null, createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listCredentialAccessLog(credentialRef?: string): Promise<CredentialAccessLogRecord[]> {
    const sql = credentialRef
      ? "SELECT * FROM credential_access_log WHERE credential_ref = ? ORDER BY created_at ASC"
      : "SELECT * FROM credential_access_log ORDER BY created_at ASC";
    const rows = credentialRef
      ? this.database.prepare(sql).all(credentialRef) as CredentialAccessLogRow[]
      : this.database.prepare(sql).all() as CredentialAccessLogRow[];
    return rows.map(accessLogRowToRecord);
  }

  async importFile(input: {
    taskId?: string;
    kind: ArtifactRecord["kind"];
    mediaType: string;
    sourcePath: string;
    extension?: string;
  }): Promise<ArtifactRecord> {
    const sourceMetadata = await lstat(input.sourcePath);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new Error("Artifact source must be a regular file");
    }

    const temporaryDirectory = join(this.rootDir, ".tmp");
    const temporaryPath = join(temporaryDirectory, `${randomUUID()}.tmp`);
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      await pipeline(
        createReadStream(input.sourcePath),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            byteLength += chunk.byteLength;
            callback(null, chunk);
          }
        }),
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
      );
      const contentHash = hash.digest("hex");
      const existing = this.database.prepare(`
        SELECT * FROM artifacts
        WHERE task_id IS ? AND content_hash = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(input.taskId ?? null, contentHash) as ArtifactRow | undefined;
      if (existing) {
        return rowToRecord(existing);
      }

      const sourceExtension = extname(input.sourcePath).slice(1);
      const extension = normalizeExtension(input.extension ?? (sourceExtension || extensionForKind(input.kind)));
      const relativePath = join(input.taskId ?? "global", `${contentHash}.${extension}`);
      const absolutePath = join(this.rootDir, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      try {
        await link(temporaryPath, absolutePath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
      const dataBuffer = await readFile(absolutePath);
      const createdAt = new Date().toISOString();
      const record: ArtifactRecord = {
        artifactRef: `artifact:${randomUUID()}`,
        taskId: input.taskId,
        kind: input.kind,
        mediaType: input.mediaType,
        path: absolutePath,
        byteLength,
        createdAt,
        preview: dataBuffer.toString("utf8", 0, Math.min(dataBuffer.byteLength, 800)),
        contentHash
      };
      const inserted = this.insertRecord(record, dataBuffer.toString("utf8"));
      if (!inserted) {
        const concurrent = this.database.prepare(`
          SELECT * FROM artifacts WHERE task_id IS ? AND content_hash = ? ORDER BY created_at DESC LIMIT 1
        `).get(input.taskId ?? null, contentHash) as ArtifactRow | undefined;
        if (concurrent) {
          return rowToRecord(concurrent);
        }
      }
      await this.appendRecord(record);
      return record;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async read(refOrPath: string, range?: { offset?: number; length?: number }): Promise<string> {
    const fileBuffer = await readFile(await this.resolvePath(refOrPath));
    const offset = range?.offset ?? 0;
    const length = range?.length ?? fileBuffer.byteLength - offset;
    return fileBuffer.subarray(offset, offset + length).toString("utf8");
  }

  async preview(refOrPath: string, maxBytes = 1000): Promise<{ byteLength: number; preview: string }> {
    const artifactPath = await this.resolvePath(refOrPath);
    const fileStat = await stat(artifactPath);
    const fileBuffer = await readFile(artifactPath);
    return {
      byteLength: fileStat.size,
      preview: fileBuffer.toString("utf8", 0, Math.min(fileBuffer.byteLength, maxBytes))
    };
  }

  async get(artifactRef: string): Promise<ArtifactRecord | undefined> {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE artifact_ref = ?")
      .get(artifactRef) as ArtifactRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async list(input: { taskId?: string } = {}): Promise<ArtifactRecord[]> {
    const rows = input.taskId
      ? this.database.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC").all(input.taskId)
      : this.database.prepare("SELECT * FROM artifacts ORDER BY created_at ASC").all();
    return (rows as ArtifactRow[]).map(rowToRecord);
  }

  stats(): Record<string, unknown> {
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS byte_length,
             COUNT(DISTINCT content_hash) AS unique_content_count
      FROM artifacts
    `).get() as { count: number; byte_length: number; unique_content_count: number };
    const byKind = Object.fromEntries((this.database.prepare(`
      SELECT kind, COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS byte_length
      FROM artifacts GROUP BY kind ORDER BY kind
    `).all() as Array<{ kind: string; count: number; byte_length: number }>).map((row) => [
      row.kind,
      { count: Number(row.count), byteLength: Number(row.byte_length) }
    ]));
    return {
      count: Number(totals.count),
      byteLength: Number(totals.byte_length),
      uniqueContentCount: Number(totals.unique_content_count),
      byKind
    };
  }

  async search(input: {
    taskId?: string;
    query: string;
    limit?: number;
  }): Promise<Array<{ artifactRef: string; chunkIndex: number; snippet: string }>> {
    const query = ftsQuery(input.query);
    if (!query) {
      return [];
    }
    const taskClause = input.taskId ? "AND task_id = ?" : "";
    const parameters = input.taskId
      ? [query, input.taskId, input.limit ?? 6]
      : [query, input.limit ?? 6];
    const rows = this.database.prepare(`
      SELECT artifact_ref, chunk_index,
             snippet(artifact_chunks_fts, 3, '', '', ' ... ', 32) AS snippet
      FROM artifact_chunks_fts
      WHERE artifact_chunks_fts MATCH ? ${taskClause}
      ORDER BY bm25(artifact_chunks_fts)
      LIMIT ?
    `).all(...parameters) as Array<{ artifact_ref: string; chunk_index: number; snippet: string }>;
    return rows.map((row) => ({
      artifactRef: row.artifact_ref,
      chunkIndex: Number(row.chunk_index),
      snippet: row.snippet
    }));
  }

  async searchWithin(input: {
    artifactRefs: string[];
    query: string;
    limit?: number;
  }): Promise<Array<{ artifactRef: string; chunkIndex: number; snippet: string }>> {
    const artifactRefs = [...new Set(input.artifactRefs)].filter((ref) => ref.startsWith("artifact:"));
    const query = ftsQuery(input.query);
    if (!query || artifactRefs.length === 0) {
      return [];
    }
    const placeholders = artifactRefs.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT artifact_ref, chunk_index,
             snippet(artifact_chunks_fts, 3, '', '', ' ... ', 32) AS snippet
      FROM artifact_chunks_fts
      WHERE artifact_chunks_fts MATCH ? AND artifact_ref IN (${placeholders})
      ORDER BY bm25(artifact_chunks_fts)
      LIMIT ?
    `).all(query, ...artifactRefs, input.limit ?? 6) as Array<{
      artifact_ref: string;
      chunk_index: number;
      snippet: string;
    }>;
    return rows.map((row) => ({
      artifactRef: row.artifact_ref,
      chunkIndex: Number(row.chunk_index),
      snippet: row.snippet
    }));
  }

  private insertRecord(record: ArtifactRecord, text: string): boolean {
    this.database.exec("BEGIN");
    try {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO artifacts (
          artifact_ref, task_id, kind, media_type, path, byte_length,
          created_at, preview, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.artifactRef,
        record.taskId ?? null,
        record.kind,
        record.mediaType,
        record.path,
        record.byteLength,
        record.createdAt,
        record.preview,
        record.contentHash ?? ""
      );
      if (Number(inserted.changes) !== 1) {
        this.database.exec("COMMIT");
        return false;
      }
      this.database.prepare("DELETE FROM artifact_chunks_fts WHERE artifact_ref = ?")
        .run(record.artifactRef);
      for (const [chunkIndex, content] of chunkText(text).entries()) {
        this.database.prepare(`
          INSERT INTO artifact_chunks_fts (artifact_ref, task_id, chunk_index, content)
          VALUES (?, ?, ?, ?)
        `).run(record.artifactRef, record.taskId ?? "", chunkIndex, content);
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async appendRecord(record: ArtifactRecord): Promise<void> {
    const indexPath = this.indexPath();
    await mkdir(dirname(indexPath), { recursive: true });
    await appendFile(indexPath, toJsonLine(record));
  }

  private async resolvePath(refOrPath: string): Promise<string> {
    if (!refOrPath.startsWith("artifact:")) {
      return refOrPath;
    }
    const record = await this.get(refOrPath);
    if (!record) {
      throw new Error(`Artifact not found: ${refOrPath}`);
    }
    return record.path;
  }

  private indexPath(): string {
    return join(this.rootDir, "index.jsonl");
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_ref TEXT PRIMARY KEY,
        task_id TEXT,
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        preview TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_task_hash ON artifacts(task_id, content_hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_chunks_fts USING fts5(
        artifact_ref UNINDEXED,
        task_id UNINDEXED,
        chunk_index UNINDEXED,
        content
      );
      CREATE TABLE IF NOT EXISTS credential_index (
        artifact_ref TEXT PRIMARY KEY REFERENCES artifacts(artifact_ref),
        scope_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        host_ref TEXT,
        label TEXT NOT NULL DEFAULT '',
        username TEXT,
        role TEXT,
        source TEXT NOT NULL DEFAULT 'auto',
        valid INTEGER NOT NULL DEFAULT 1,
        graph_node_id TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cred_scope ON credential_index(scope_ref, valid);
      CREATE INDEX IF NOT EXISTS idx_cred_host ON credential_index(host_ref);
      CREATE INDEX IF NOT EXISTS idx_cred_role ON credential_index(role);
      CREATE TABLE IF NOT EXISTS credential_access_log (
        id TEXT PRIMARY KEY,
        credential_ref TEXT NOT NULL,
        task_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cred_access_ref ON credential_access_log(credential_ref);
    `);
  }

  private importLegacyIndex(): void {
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM artifacts").get() as { count: number };
    if (Number(count.count) > 0 || !existsSync(this.indexPath())) {
      return;
    }
    const lines = readFileSync(this.indexPath(), "utf8").split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const legacy = JSON.parse(line) as ArtifactRecord;
      if (!existsSync(legacy.path)) {
        continue;
      }
      const data = readFileSync(legacy.path);
      const record = {
        ...legacy,
        contentHash: legacy.contentHash ?? createHash("sha256").update(data).digest("hex")
      };
      this.insertRecord(record, data.toString("utf8"));
    }
  }
}

function rowToRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifactRef: row.artifact_ref,
    taskId: row.task_id ?? undefined,
    kind: row.kind,
    mediaType: row.media_type,
    path: row.path,
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    preview: row.preview,
    contentHash: row.content_hash
  };
}

function chunkText(text: string, size = 2000, overlap = 200): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size - overlap) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

function ftsQuery(value: string): string {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/["'():*^{}\[\]]/g, "").trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

function extensionForKind(kind: ArtifactRecord["kind"]): string {
  switch (kind) {
    case "json":
      return "json";
    case "screenshot":
      return "png";
    case "poc":
      return "txt";
    case "report":
      return "md";
    default:
      return "txt";
  }
}

function normalizeExtension(value: string): string {
  const stripped = value.replace(/^\.+/, "").toLowerCase();
  const normalized = stripped.includes(".")
    ? stripped.slice(stripped.lastIndexOf(".") + 1)
    : stripped;
  if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(normalized)) {
    throw new Error(`Invalid artifact extension: ${value}`);
  }
  return normalized;
}

type CredentialIndexRow = {
  artifact_ref: string;
  scope_ref: string;
  kind: string;
  host_ref: string | null;
  label: string;
  username: string | null;
  role: string | null;
  source: string;
  valid: number;
  graph_node_id: string | null;
  created_at: string;
  last_used_at: string | null;
};

type CredentialAccessLogRow = {
  id: string;
  credential_ref: string;
  task_id: string | null;
  action: string;
  actor: string;
  details: string | null;
  created_at: string;
};

function credentialRowToRecord(row: CredentialIndexRow): CredentialIndexRecord {
  return {
    artifactRef: row.artifact_ref,
    scopeRef: row.scope_ref,
    kind: row.kind as CredentialIndexRecord["kind"],
    hostRef: row.host_ref ?? undefined,
    label: row.label,
    username: row.username ?? undefined,
    role: row.role ?? undefined,
    source: row.source as CredentialIndexRecord["source"],
    valid: Boolean(row.valid),
    graphNodeId: row.graph_node_id ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined
  };
}

function accessLogRowToRecord(row: CredentialAccessLogRow): CredentialAccessLogRecord {
  return {
    id: row.id,
    credentialRef: row.credential_ref,
    taskId: row.task_id ?? undefined,
    action: row.action as CredentialAccessLogRecord["action"],
    actor: row.actor,
    details: row.details ?? undefined,
    createdAt: row.created_at
  };
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
