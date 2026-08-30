import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ParsedScopeDocument, ScopeTextFragment } from "./scope-document-types.js";

export type StoredScopeDocument = {
  parsed: ParsedScopeDocument;
  fragments: ScopeTextFragment[];
};

export class ScopeDocumentStore {
  constructor(readonly rootDir: string) {}

  async put(input: StoredScopeDocument & { data: Buffer }): Promise<void> {
    const documentDir = this.documentDir(input.parsed.documentId);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(documentDir, { mode: 0o700 });
    await Promise.all([
      writeFile(join(documentDir, "source.bin"), input.data, { mode: 0o600 }),
      writeFile(join(documentDir, "result.json"), JSON.stringify(input.parsed, null, 2), { mode: 0o600 }),
      writeFile(join(documentDir, "extracted.json"), JSON.stringify(input.fragments), { mode: 0o600 })
    ]);
  }

  async get(documentId: string): Promise<StoredScopeDocument | undefined> {
    const documentDir = this.documentDir(documentId);
    try {
      const stats = await lstat(documentDir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
      const [result, fragments] = await Promise.all([
        readFile(join(documentDir, "result.json"), "utf8"),
        readFile(join(documentDir, "extracted.json"), "utf8")
      ]);
      return {
        parsed: JSON.parse(result) as ParsedScopeDocument,
        fragments: JSON.parse(fragments) as ScopeTextFragment[]
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async copyToRuntime(documentId: string, runtimeDir: string): Promise<void> {
    const sourceDir = this.documentDir(documentId);
    if (!await this.get(documentId)) throw new Error(`Scope document not found: ${documentId}`);
    const targetDir = join(runtimeDir, "scope-document");
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      copyFile(join(sourceDir, "source.bin"), join(targetDir, "source.bin")),
      copyFile(join(sourceDir, "result.json"), join(targetDir, "result.json")),
      copyFile(join(sourceDir, "extracted.json"), join(targetDir, "extracted.json"))
    ]);
  }

  private documentDir(documentId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId)) {
      throw new Error("Invalid scope document id");
    }
    const root = resolve(this.rootDir);
    const candidate = resolve(root, documentId);
    if (!candidate.startsWith(`${root}${sep}`)) throw new Error("Scope document path escapes its root");
    return candidate;
  }
}
