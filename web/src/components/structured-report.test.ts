import { describe, expect, it } from "vitest";
import { groupReportSections, parseStructuredReport } from "./structured-report";

describe("parseStructuredReport", () => {
  it("parses section headings, key/value rows and ordered steps", () => {
    const blocks = parseStructuredReport("== TARGET ==\nHost: example.test\n\n== STEPS ==\n1. Sent request\n2. Saved evidence");
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, text: "TARGET" });
    expect(blocks[1]).toEqual({ kind: "kv", entries: [{ key: "Host", value: "example.test" }] });
    expect(blocks[3]).toEqual({ kind: "list", ordered: true, items: ["Sent request", "Saved evidence"] });
  });

  it("keeps plain TaskOutcome text without inventing sections", () => {
    const text = "Observed the endpoint.\nNo confirmed issue.";
    expect(parseStructuredReport(text)).toEqual([{ kind: "paragraph", text }]);
  });

  it("groups top-level report sections in source order", () => {
    const sections = groupReportSections(parseStructuredReport("intro\n== A ==\nalpha\n== B ==\nbeta"));
    expect(sections.map((section) => section.heading?.text)).toEqual([undefined, "A", "B"]);
  });
});
