import type { ArtifactRecord, TaskOutcome } from "./types.js";
import { basename } from "node:path";

export type FinalReport = {
  taskRef: string;
  summary: string;
  createdAt: string;
  artifactRefs: string[];
  artifacts: ArtifactRecord[];
  taskType?: "ctf" | "pentest";
};

export function deriveFinalReport(
  taskOutcomes: TaskOutcome[],
  artifacts: ArtifactRecord[]
): FinalReport | undefined {
  const reportArtifactByRef = new Map(
    artifacts
      .filter((artifact) => artifact.kind === "report")
      .map((artifact) => [artifact.artifactRef, artifact])
  );
  const outcome = [...taskOutcomes]
    .sort((left, right) => right.terminalSeq - left.terminalSeq)
    .find((candidate) => candidate.status === "completed"
      && candidate.artifactRefs.some((ref) => reportArtifactByRef.has(ref)));
  if (!outcome) return undefined;
  const reportArtifacts = outcome.artifactRefs.flatMap((ref) => {
    const artifact = reportArtifactByRef.get(ref);
    return artifact ? [artifact] : [];
  });
  return {
    taskRef: outcome.taskRef,
    summary: outcome.summary,
    createdAt: outcome.createdAt,
    artifactRefs: reportArtifacts.map((artifact) => artifact.artifactRef),
    artifacts: reportArtifacts,
    taskType: reportArtifacts.some((artifact) => basename(artifact.path ?? "") === "writeup.md") ? "ctf" : "pentest"
  };
}
