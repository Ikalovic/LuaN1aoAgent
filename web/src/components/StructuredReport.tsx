import { useMemo, useState } from "react";
import { Segmented, Typography } from "antd";
import { FileCode2, Rows3 } from "lucide-react";
import { groupReportSections, parseStructuredReport, type ReportBlock } from "./structured-report";

export function StructuredReport({ text, className }: { text: string; className?: string }) {
  const [mode, setMode] = useState<"structured" | "raw">("structured");
  const sections = useMemo(() => groupReportSections(parseStructuredReport(text)), [text]);
  return (
    <div className={`structured-report${className ? ` ${className}` : ""}`}>
      <div className="structured-report-toolbar">
        <Segmented
          size="small"
          value={mode}
          onChange={(value) => setMode(value as "structured" | "raw")}
          options={[
            { value: "structured", label: "结构化视图", icon: <Rows3 size={13} /> },
            { value: "raw", label: "原始文本", icon: <FileCode2 size={13} /> }
          ]}
        />
      </div>
      {mode === "raw" ? <pre className="structured-report-raw">{text}</pre> : sections.length ? (
        <div className="structured-report-body">
          {sections.map((section, index) => {
            const content = section.blocks.map((block, blockIndex) => <ReportBlockView key={blockIndex} block={block} />);
            if (!section.heading) return <div className="sr-section-plain" key={index}>{content}</div>;
            return (
              <details className="sr-section" key={`${index}:${section.heading.text}`} open={index === 0}>
                <summary><Typography.Title level={section.heading.level >= 3 ? 5 : 4}>{section.heading.text}</Typography.Title></summary>
                <div className="sr-section-body">{content}</div>
              </details>
            );
          })}
        </div>
      ) : <pre className="structured-report-raw">{text}</pre>}
    </div>
  );
}

function ReportBlockView({ block }: { block: ReportBlock }) {
  if (block.kind === "heading") return <Typography.Title className="sr-subheading" level={5}>{block.text}</Typography.Title>;
  if (block.kind === "list") {
    const TagName = block.ordered ? "ol" : "ul";
    return <TagName className="sr-list">{block.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</TagName>;
  }
  if (block.kind === "kv") {
    return <dl className="sr-kv">{block.entries.map((entry, index) => (
      <div className="sr-kv-row" key={`${index}:${entry.key}`}><dt>{entry.key}</dt><dd>{entry.value}</dd></div>
    ))}</dl>;
  }
  if (block.kind === "code") return <pre className="sr-code"><code>{block.text}</code></pre>;
  return <p className="sr-paragraph">{block.text}</p>;
}
