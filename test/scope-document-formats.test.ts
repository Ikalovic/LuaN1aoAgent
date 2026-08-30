import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  extractScopeText,
  ScopeDocumentError,
  SCOPE_DOCUMENT_LIMITS
} from "../src/scope-documents/scope-document-formats.js";

test("extracts numbered text and Markdown lines", async () => {
  assert.deepEqual(await extractScopeText("scope.txt", Buffer.from("a.example\n10.0.0.1")), [
    { text: "a.example", line: 1 },
    { text: "10.0.0.1", line: 2 }
  ]);
  assert.deepEqual(await extractScopeText("scope.md", Buffer.from("# Scope\n*.example.com")), [
    { text: "# Scope", line: 1 },
    { text: "*.example.com", line: 2 }
  ]);
});

test("flattens CSV rows and JSON scalar paths", async () => {
  assert.deepEqual(await extractScopeText("scope.csv", Buffer.from("kind,value\ndomain,api.example")), [
    { text: "kind value", line: 1 },
    { text: "domain api.example", line: 2 }
  ]);
  assert.deepEqual(await extractScopeText("scope.json", Buffer.from('{"targets":[{"domain":"api.example"}]}')), [
    { text: "targets.0.domain api.example", line: 1 }
  ]);
});

test("extracts DOCX paragraphs without reading unrelated zip entries", async () => {
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body>`
    + `<w:p><w:r><w:t>api.example</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t>10.0.0.0/24</w:t></w:r></w:p>`
    + `</w:body></w:document>`;
  const docx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(documentXml),
    "word/ignored.xml": strToU8("secret.invalid")
  });
  assert.deepEqual(await extractScopeText("scope.docx", Buffer.from(docx)), [
    { text: "api.example", paragraph: 1 },
    { text: "10.0.0.0/24", paragraph: 2 }
  ]);
});

test("extracts text-layer PDF by page", async () => {
  const fragments = await extractScopeText("scope.pdf", createPdf("api.example 10.0.0.1"));
  assert.deepEqual(fragments, [{ text: "api.example 10.0.0.1", page: 1 }]);
});

test("rejects image-only PDF, unsupported types, and oversized input", async () => {
  await assert.rejects(
    () => extractScopeText("scan.pdf", createPdf()),
    (error: unknown) => error instanceof ScopeDocumentError && error.code === "scanned_pdf_not_supported"
  );
  await assert.rejects(
    () => extractScopeText("scope.exe", Buffer.from("x")),
    (error: unknown) => error instanceof ScopeDocumentError && error.code === "unsupported_document_type"
  );
  await assert.rejects(
    () => extractScopeText("scope.txt", Buffer.alloc(SCOPE_DOCUMENT_LIMITS.inputBytes + 1)),
    (error: unknown) => error instanceof ScopeDocumentError && error.code === "document_too_large"
  );
});

function createPdf(text?: string): Buffer {
  const stream = text
    ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`
    : "0 0 100 100 re S";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}
