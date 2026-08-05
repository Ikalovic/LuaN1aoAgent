import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactsView } from "./ArtifactsView";

describe("ArtifactsView", () => {
  it("prefers a persisted report Artifact over the Planner summary and latest TaskOutcome", () => {
    render(
      <ArtifactsView
        runtimeDir="/tmp/runtime"
        artifacts={[{
          artifactRef: "artifact:final-report",
          taskId: "task:final-report",
          kind: "report",
          mediaType: "text/markdown",
          path: "/tmp/runtime/artifacts/final-report.md",
          byteLength: 256
        }]}
        epochOutcomes={[]}
        tasks={[]}
        finalReport={{
          taskRef: "task:final-report",
          summary: "== REPORT ==\nStatus: delivered",
          createdAt: "2026-08-05T01:00:12.000Z",
          artifactRefs: ["artifact:final-report"],
          artifacts: [{
            artifactRef: "artifact:final-report",
            taskId: "task:final-report",
            kind: "report",
            mediaType: "text/markdown",
            path: "/tmp/runtime/artifacts/final-report.md",
            byteLength: 256
          }]
        }}
        finalResult={{
          summary: "Planner fallback",
          createdAt: "2026-08-05T01:00:11.000Z",
          sourceEventId: "event:planner-final"
        }}
        latestTaskOutcome={{
          taskRef: "task:latest",
          epochRef: "epoch:latest:1",
          status: "completed",
          summary: "Latest task fallback",
          evidenceRefs: [],
          artifactRefs: [],
          capabilityRefs: [],
          terminalSeq: 9,
          createdAt: "2026-08-05T01:00:09.000Z"
        }}
        taskOutcomes={[]}
      />
    );

    expect(screen.getByRole("heading", { name: "最终报告" })).toBeInTheDocument();
    expect(screen.getByText("delivered")).toBeInTheDocument();
    expect(screen.getByText("final-report.md")).toBeInTheDocument();
    expect(screen.queryByText("Planner fallback")).not.toBeInTheDocument();
    expect(screen.queryByText("Latest task fallback")).not.toBeInTheDocument();
  });

  it("prefers the persisted run-wide final result over the latest TaskOutcome", () => {
    render(
      <ArtifactsView
        runtimeDir="/tmp/runtime"
        artifacts={[]}
        epochOutcomes={[]}
        tasks={[]}
        finalResult={{
          summary: "== FINAL ==\n- port 8000 complete\n- port 8001 complete\n- port 8002 complete",
          createdAt: "2026-08-05T01:00:11.000Z",
          sourceEventId: "event:planner-final"
        }}
        latestTaskOutcome={{
          taskRef: "task:port-8002",
          epochRef: "epoch:port-8002:1",
          status: "completed",
          summary: "Only port 8002",
          evidenceRefs: [],
          artifactRefs: [],
          capabilityRefs: [],
          terminalSeq: 9,
          createdAt: "2026-08-05T01:00:09.000Z"
        }}
        taskOutcomes={[]}
      />
    );

    expect(screen.getByRole("heading", { name: "最终结果" })).toBeInTheDocument();
    expect(screen.getByText("port 8000 complete")).toBeInTheDocument();
    expect(screen.queryByText("Only port 8002")).not.toBeInTheDocument();
    expect(screen.getByText("event:planner-final")).toBeInTheDocument();
  });
});
