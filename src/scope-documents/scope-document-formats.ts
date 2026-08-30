import { createRequire } from "node:module";
import { dirname, extname, join, posix } from "node:path";
import { unzipSync } from "fflate";
import type { ScopeTextFragment } from "./scope-document-types.js";

export const SCOPE_DOCUMENT_LIMITS = {
  inputBytes: 5 * 1024 * 1024,
  expandedBytes: 20 * 1024 * 1024,
  fragments: 10_000,
  textBytes: 2 * 1024 * 1024,
  jsonDepth: 32,
  jsonNodes: 20_000,
  pdfPages: 500
} as const;

export class ScopeDocumentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ScopeDocumentError";
  }
}

export async function extractScopeText(fileName: string, data: Buffer): Promise<ScopeTextFragment[]> {
  if (data.byteLength > SCOPE_DOCUMENT_LIMITS.inputBytes) {
    throw new ScopeDocumentError("document_too_large", "授权文件不能超过 5 MiB");
  }
  const extension = extname(fileName).toLowerCase();
  let fragments: ScopeTextFragment[];
  switch (extension) {
    case ".txt":
    case ".md":
      fragments = textLines(decodeUtf8(data));
      break;
    case ".csv":
      fragments = csvRows(decodeUtf8(data));
      break;
    case ".json":
      fragments = jsonScalars(decodeUtf8(data));
      break;
    case ".docx":
      fragments = docxParagraphs(data);
      break;
    case ".xlsx":
      fragments = xlsxCells(data);
      break;
    case ".pdf":
      fragments = await pdfPages(data);
      break;
    default:
      throw new ScopeDocumentError("unsupported_document_type", `不支持的授权文件格式：${extension || "无扩展名"}`);
  }
  return enforceOutputLimits(fragments);
}

function decodeUtf8(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new ScopeDocumentError("invalid_document_encoding", "授权文件不是有效的 UTF-8 文本");
  }
}

function textLines(text: string): ScopeTextFragment[] {
  return text.split(/\r?\n/).flatMap((value, index) => {
    const line = value.trim();
    return line ? [{ text: line, line: index + 1 }] : [];
  });
}

function csvRows(text: string): ScopeTextFragment[] {
  const rows: string[][] = [[""]];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        rows.at(-1)![rows.at(-1)!.length - 1] += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      rows.at(-1)!.push("");
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      rows.push([""]);
    } else {
      const row = rows.at(-1)!;
      row[row.length - 1] += character;
    }
  }
  if (quoted) throw new ScopeDocumentError("invalid_csv", "CSV 包含未闭合的引号");
  return rows.flatMap((row, index) => {
    const value = row.map((cell) => cell.trim()).filter(Boolean).join(" ");
    return value ? [{ text: value, line: index + 1 }] : [];
  });
}

function jsonScalars(text: string): ScopeTextFragment[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ScopeDocumentError("invalid_json", "授权 JSON 文件无法解析");
  }
  const fragments: ScopeTextFragment[] = [];
  let visited = 0;
  const visit = (current: unknown, path: string[], depth: number): void => {
    visited += 1;
    if (visited > SCOPE_DOCUMENT_LIMITS.jsonNodes || depth > SCOPE_DOCUMENT_LIMITS.jsonDepth) {
      throw new ScopeDocumentError("document_too_complex", "授权 JSON 结构超过解析限制");
    }
    if (current === null || typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
      const scalar = String(current).trim();
      if (scalar) fragments.push({
        text: path.length > 0 ? `${path.join(".")} ${scalar}` : scalar,
        line: fragments.length + 1
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
      return;
    }
    if (typeof current === "object") {
      Object.entries(current as Record<string, unknown>).forEach(([key, item]) => visit(item, [...path, key], depth + 1));
    }
  };
  visit(value, [], 0);
  return fragments;
}

function docxParagraphs(data: Buffer): ScopeTextFragment[] {
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new ScopeDocumentError("invalid_docx", "DOCX 文件签名无效");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(data));
  } catch {
    throw new ScopeDocumentError("invalid_docx", "DOCX 压缩包无法解析");
  }
  const expandedBytes = Object.values(entries).reduce((sum, entry) => sum + entry.byteLength, 0);
  if (expandedBytes > SCOPE_DOCUMENT_LIMITS.expandedBytes) {
    throw new ScopeDocumentError("document_too_large", "DOCX 解压后内容超过 20 MiB");
  }
  const document = entries["word/document.xml"];
  if (!document) throw new ScopeDocumentError("invalid_docx", "DOCX 缺少 word/document.xml");
  const xml = decodeUtf8(Buffer.from(document));
  const paragraphs: ScopeTextFragment[] = [];
  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const text = [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((part) => decodeXml(part[1]))
      .join("")
      .trim();
    if (text) paragraphs.push({ text, paragraph: paragraphs.length + 1 });
  }
  return paragraphs;
}

function xlsxCells(data: Buffer): ScopeTextFragment[] {
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new ScopeDocumentError("invalid_xlsx", "XLSX 文件签名无效");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(data));
  } catch {
    throw new ScopeDocumentError("invalid_xlsx", "XLSX 压缩包无法解析");
  }
  const expandedBytes = Object.values(entries).reduce((sum, entry) => sum + entry.byteLength, 0);
  if (expandedBytes > SCOPE_DOCUMENT_LIMITS.expandedBytes) {
    throw new ScopeDocumentError("document_too_large", "XLSX 解压后内容超过 20 MiB");
  }
  const workbook = xlsxXml(entries, "xl/workbook.xml");
  const relationships = xlsxXml(entries, "xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(entries["xl/sharedStrings.xml"]);
  const relationshipPaths = new Map<string, string>();
  for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1];
    const id = xmlAttribute(attributes, "Id");
    const type = xmlAttribute(attributes, "Type");
    const target = xmlAttribute(attributes, "Target");
    const targetMode = xmlAttribute(attributes, "TargetMode");
    if (!id || !type?.endsWith("/worksheet") || !target || targetMode?.toLowerCase() === "external") continue;
    const path = xlsxRelationshipPath(target);
    if (!path || relationshipPaths.has(id)) {
      throw new ScopeDocumentError("invalid_xlsx", "XLSX 工作表关系无效");
    }
    relationshipPaths.set(id, path);
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const name = xmlAttribute(match[1], "name");
    const relationshipId = xmlAttribute(match[1], "r:id");
    const path = relationshipId ? relationshipPaths.get(relationshipId) : undefined;
    if (!name || !path) {
      throw new ScopeDocumentError("invalid_xlsx", "XLSX 工作表元数据无效");
    }
    sheets.push({ name: decodeXml(name), path });
  }
  if (sheets.length === 0) {
    throw new ScopeDocumentError("invalid_xlsx", "XLSX 不包含工作表");
  }
  return sheets.flatMap(({ name, path }) => parseWorksheet(xlsxXml(entries, path), name, sharedStrings));
}

function xlsxXml(entries: Record<string, Uint8Array>, path: string): string {
  const entry = entries[path];
  if (!entry) throw new ScopeDocumentError("invalid_xlsx", "XLSX 缺少必要的工作簿内容");
  try {
    return decodeUtf8(Buffer.from(entry));
  } catch {
    throw new ScopeDocumentError("invalid_xlsx", "XLSX XML 编码无效");
  }
}

function xlsxRelationshipPath(value: string): string | undefined {
  const target = decodeXml(value).replace(/\\/g, "/");
  const resolved = target.startsWith("/")
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join("xl", target));
  return resolved.startsWith("xl/") && resolved !== "xl/" ? resolved : undefined;
}

function parseSharedStrings(entry: Uint8Array | undefined): string[] {
  if (!entry) return [];
  let xml: string;
  try {
    xml = decodeUtf8(Buffer.from(entry));
  } catch {
    throw new ScopeDocumentError("invalid_xlsx", "XLSX 共享字符串编码无效");
  }
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)]
    .map((match) => xlsxTextNodes(match[1]));
}

function parseWorksheet(xml: string, sheet: string, sharedStrings: string[]): ScopeTextFragment[] {
  const fragments: ScopeTextFragment[] = [];
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const cell = xmlAttribute(match[1], "r")?.toUpperCase();
    const type = xmlAttribute(match[1], "t")?.toLowerCase();
    const body = match[2];
    let text = "";
    if (type === "inlinestr") {
      text = xlsxTextNodes(body);
    } else {
      const rawValue = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i.exec(body)?.[1];
      if (rawValue === undefined || type === "e") continue;
      if (type === "s") {
        const index = Number(rawValue.trim());
        if (!Number.isSafeInteger(index) || index < 0 || sharedStrings[index] === undefined) {
          throw new ScopeDocumentError("invalid_xlsx", "XLSX 共享字符串索引无效");
        }
        text = sharedStrings[index];
      } else {
        text = decodeXml(rawValue);
      }
    }
    text = text.trim();
    if (!text) continue;
    if (!cell || !/^[A-Z]{1,3}[1-9]\d*$/.test(cell)) {
      throw new ScopeDocumentError("invalid_xlsx", "XLSX 单元格地址无效");
    }
    fragments.push({ text, sheet, cell });
  }
  return fragments;
}

function xlsxTextNodes(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i")
    .exec(attributes)?.[2];
}

async function pdfPages(data: Buffer): Promise<ScopeTextFragment[]> {
  if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new ScopeDocumentError("invalid_pdf", "PDF 文件签名无效");
  }
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const packagePath = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");
    const loadingTask = getDocument({
      data: new Uint8Array(data),
      standardFontDataUrl: join(dirname(packagePath), "standard_fonts") + "/",
      useSystemFonts: false
    });
    const document = await loadingTask.promise;
    if (document.numPages > SCOPE_DOCUMENT_LIMITS.pdfPages) {
      throw new ScopeDocumentError("document_too_complex", "PDF 页数超过 500 页");
    }
    const fragments: ScopeTextFragment[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ").replace(/\s+/g, " ").trim();
      if (text) fragments.push({ text, page: pageNumber });
      page.cleanup();
    }
    await loadingTask.destroy();
    if (fragments.length === 0) {
      throw new ScopeDocumentError("scanned_pdf_not_supported", "PDF 不含可提取文本；当前不支持扫描件 OCR");
    }
    return fragments;
  } catch (error) {
    if (error instanceof ScopeDocumentError) throw error;
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (/Password/i.test(name)) throw new ScopeDocumentError("encrypted_pdf_not_supported", "不支持加密 PDF");
    throw new ScopeDocumentError("invalid_pdf", "PDF 文件无法解析");
  }
}

function enforceOutputLimits(fragments: ScopeTextFragment[]): ScopeTextFragment[] {
  if (fragments.length > SCOPE_DOCUMENT_LIMITS.fragments) {
    throw new ScopeDocumentError("document_too_complex", "授权文件片段数量超过 10000");
  }
  const textBytes = fragments.reduce((sum, fragment) => sum + Buffer.byteLength(fragment.text), 0);
  if (textBytes > SCOPE_DOCUMENT_LIMITS.textBytes) {
    throw new ScopeDocumentError("document_too_large", "授权文件可提取文本超过 2 MiB");
  }
  return fragments;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
