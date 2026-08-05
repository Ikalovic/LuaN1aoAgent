export type ReportBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "kv"; entries: Array<{ key: string; value: string }> }
  | { kind: "code"; text: string }
  | { kind: "paragraph"; text: string };

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const SECTION_HEADING = /^==+\s*(.+?)\s*==+\s*$/;
const UPPERCASE_HEADING = /^([A-Z0-9][A-Z0-9 _\-\/&.%]{1,70}(?:\s+\([^\n:]*\))?)\s*:\s*$/;
const UNORDERED_ITEM = /^\s*(?:[-*•]|\u2022)\s+(.+)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.+)$/;
const KEY_VALUE = /^([A-Za-z][\w .\/()\-]{0,48}?):\s+(\S(?:.*\S)?)\s*$/;
const COMMAND_LINE = /^\s*(?:[$>]\s+\S|(?:curl|wget|nuclei|nmap|sqlmap|ffuf|gobuster|nikto|wpscan|hydra|john|hashcat|python3?|bash|sh|nc|ncat|socat|ssh|git|docker|kubectl|cat|echo|grep|find|chmod|chown|sudo)\s+\S)/;

export function parseStructuredReport(text: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let fenceLines: string[] = [];
  let mergeOpen = true;
  const last = (): ReportBlock | undefined => (mergeOpen ? blocks[blocks.length - 1] : undefined);

  for (const line of lines) {
    const trimmed = line.trim();
    if (inFence) {
      if (/^\s*```/.test(line)) {
        blocks.push({ kind: "code", text: fenceLines.join("\n") });
        fenceLines = [];
        inFence = false;
      } else {
        fenceLines.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      inFence = true;
      fenceLines = [];
      continue;
    }
    if (!trimmed) {
      mergeOpen = false;
      continue;
    }
    const markdown = trimmed.match(MARKDOWN_HEADING);
    if (markdown) {
      blocks.push({ kind: "heading", level: markdown[1].length, text: markdown[2] });
      mergeOpen = true;
      continue;
    }
    const section = trimmed.match(SECTION_HEADING);
    if (section?.[1].trim()) {
      blocks.push({ kind: "heading", level: 2, text: section[1].trim() });
      mergeOpen = true;
      continue;
    }
    const upper = trimmed.match(UPPERCASE_HEADING);
    if (upper && /[A-Z]{2}/.test(upper[1].split("(", 1)[0])) {
      blocks.push({ kind: "heading", level: 3, text: upper[1].trim() });
      mergeOpen = true;
      continue;
    }
    const unordered = line.match(UNORDERED_ITEM);
    if (unordered) {
      const block = last();
      if (block?.kind === "list" && !block.ordered) block.items.push(unordered[1]);
      else blocks.push({ kind: "list", ordered: false, items: [unordered[1]] });
      mergeOpen = true;
      continue;
    }
    const ordered = line.match(ORDERED_ITEM);
    if (ordered) {
      const block = last();
      if (block?.kind === "list" && block.ordered) block.items.push(ordered[1]);
      else blocks.push({ kind: "list", ordered: true, items: [ordered[1]] });
      mergeOpen = true;
      continue;
    }
    const kv = trimmed.match(KEY_VALUE);
    if (kv && !/^https?$/.test(kv[1].toLowerCase())) {
      const block = last();
      const entry = { key: kv[1].trim(), value: kv[2] };
      if (block?.kind === "kv") block.entries.push(entry);
      else blocks.push({ kind: "kv", entries: [entry] });
      mergeOpen = true;
      continue;
    }
    if (COMMAND_LINE.test(line)) {
      const block = last();
      if (block?.kind === "code") block.text += `\n${line}`;
      else blocks.push({ kind: "code", text: line });
      mergeOpen = true;
      continue;
    }
    const block = last();
    if (block?.kind === "paragraph") block.text += `\n${line}`;
    else blocks.push({ kind: "paragraph", text: line });
    mergeOpen = true;
  }
  if (inFence) blocks.push({ kind: "code", text: fenceLines.join("\n") });
  return blocks;
}

export interface ReportSection {
  heading?: ReportBlock & { kind: "heading" };
  blocks: ReportBlock[];
}

export function groupReportSections(blocks: ReportBlock[]): ReportSection[] {
  const sections: ReportSection[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level <= 2) {
      sections.push({ heading: block, blocks: [] });
    } else if (sections.length) {
      sections[sections.length - 1].blocks.push(block);
    } else {
      sections.push({ blocks: [block] });
    }
  }
  return sections;
}
