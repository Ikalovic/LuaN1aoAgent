import assert from "node:assert/strict";
import test from "node:test";
import {
  aliasProjectionGraphContext,
  buildProjectionObservations,
  causalObservationDigest,
  capabilityDigest,
  compactProjectionBatchForInput,
  compactProjectionGraphContextForInput,
  expandProjectionDraft,
  filterProjectorSemanticGraph,
  observationDigest,
  partitionProjectionBatchForInput,
  renderProjectionGraphContext,
  renderProjectionObservations,
  selectProjectionBatch,
  type ProjectionObservation
} from "../src/projection.js";
import type { ExecutionEvent, GraphEdge, GraphNode } from "../src/types.js";

test("merges Pi tool events into action observations and excludes runtime context reads", () => {
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", {
      text: "验证上传接口认证差异",
      toolCalls: [{ id: "call:upload", name: "bash", arguments: {} }]
    }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:upload",
      toolName: "bash",
      args: { command: "curl http://10.0.0.5/api/upload.php" }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:upload",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "HTTP/1.1 403 Forbidden /api/upload.php" }] }
    }),
    event(4, "event:skill-start", "tool_started", {
      toolCallId: "call:skill",
      toolName: "read",
      args: { path: "/Users/test/.agents/skills/ctf-web/SKILL.md" }
    }),
    event(5, "event:skill-end", "tool_finished", {
      toolCallId: "call:skill",
      toolName: "read",
      result: { content: [{ type: "text", text: "skill instructions" }] }
    }),
    event(6, "event:partial", "task_partial", {
      taskResult: { summary: "上传接口存在，认证仍待验证" }
    })
  ];

  const observations = buildProjectionObservations(events);

  assert.equal(observations.length, 2);
  assert.equal(observations[0]?.action, "bash");
  assert.equal(observations[0]?.intent, "验证上传接口认证差异");
  assert.equal(observations[0]?.executorCommentary, undefined);
  assert.deepEqual(observations[0]?.sourceEventIds, ["event:start", "event:end"]);
  assert.ok(observations[0]?.anchors.includes("10.0.0.5"));
  assert.ok(observations[0]?.anchors.includes("/api/upload.php"));
  assert.equal(observations.some((observation) => observation.outcomeDigest.includes("skill instructions")), false);

  const batch = selectProjectionBatch(events, { fromSeq: 0, maxObservations: 1 });
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.toSeq, 3);
});

test("closes a long tool result with separate Executor commentary without treating it as evidence", () => {
  const longResult = `${"HTTP 403\n".repeat(80)}/keys/../public/static/README.md 200\n${"HTTP 403\n".repeat(80)}`;
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", {
      text: "比较 /keys 路径规范化差异",
      toolCalls: [{ id: "call:keys", name: "bash", arguments: {} }]
    }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:keys",
      toolName: "bash",
      args: { command: "probe keys traversal variants" }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:keys",
      toolName: "bash",
      result: { content: [{ type: "text", text: longResult }] }
    }),
    event(4, "event:interpretation", "assistant_intent", {
      text: "我认为 /keys 可穿越；下一步改查 10.9.9.9/wrong.php。",
      toolCalls: [{ id: "call:next", name: "bash", arguments: {} }]
    })
  ];

  const observations = buildProjectionObservations(events);
  const batch = selectProjectionBatch(events, { fromSeq: 0, maxObservations: 4 });

  assert.equal(observations.length, 1);
  assert.match(observations[0]?.executorCommentary ?? "", /我认为 \/keys 可穿越/);
  assert.deepEqual(observations[0]?.sourceEventIds, ["event:start", "event:end"]);
  assert.doesNotMatch(observations[0]?.anchors.join(" ") ?? "", /10\.9\.9\.9|wrong\.php/);
  assert.match(renderProjectionObservations(observations), /executor_commentary_non_evidence: "我认为 \/keys 可穿越/);
  const digest = causalObservationDigest(observations);
  assert.ok(digest.indexOf("outcome=") < digest.indexOf("executor_commentary="));
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.toSeq, 3);
});

test("groups parallel tool results by their originating Executor turn", () => {
  const observations = buildProjectionObservations([
    event(1, "event:intent", "assistant_intent", {
      text: "并行确认两个服务",
      toolCalls: [
        { id: "call:http", name: "bash", arguments: {} },
        { id: "call:ssh", name: "bash", arguments: {} }
      ]
    }),
    event(2, "event:start-http", "tool_started", {
      toolCallId: "call:http",
      toolName: "bash",
      args: { command: "curl http://10.0.0.5/" }
    }),
    event(3, "event:start-ssh", "tool_started", {
      toolCallId: "call:ssh",
      toolName: "bash",
      args: { command: "nc -vz 10.0.0.5 22" }
    }),
    event(4, "event:end-http", "tool_finished", {
      toolCallId: "call:http",
      toolName: "bash",
      result: { content: [{ type: "text", text: "HTTP/1.1 200 OK" }] }
    }),
    event(5, "event:end-ssh", "tool_finished", {
      toolCallId: "call:ssh",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Connection succeeded" }] }
    }),
    event(6, "event:interpretation", "assistant_intent", {
      text: "目标同时开放 HTTP 和 SSH，下一步检查认证面。"
    })
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.action, "tool_group");
  assert.equal(observations[0]?.actions?.length, 2);
  assert.match(observations[0]?.executorCommentary ?? "", /同时开放 HTTP 和 SSH/);
  const rendered = renderProjectionObservations(observations);
  assert.match(rendered, /tool\[1\]: bash/);
  assert.equal(rendered.match(/executor_commentary_non_evidence:/g)?.length, 1);
  assert.deepEqual(observations[0]?.sourceEventIds, [
    "event:start-http", "event:end-http", "event:start-ssh", "event:end-ssh"
  ]);
});

test("does not advance projection watermark past an unclosed action", () => {
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", { text: "验证内部读取能力" }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:read",
      toolName: "bash",
      args: { command: "read candidate" }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:read",
      toolName: "bash",
      result: { content: [{ type: "text", text: "large result awaiting interpretation" }] }
    })
  ];

  const batch = selectProjectionBatch(events, { fromSeq: 0, maxObservations: 4 });

  assert.equal(batch.observations.length, 0);
  assert.equal(batch.toSeq, 0);
});

test("only terminal task result events become task outcome observations", () => {
  const observations = buildProjectionObservations([
    event(1, "event:created", "task_created", { goal: "Initial task definition" }),
    event(2, "event:wave", "task_wave_started", { taskIds: ["task:test"] }),
    event(3, "event:epoch", "epoch_transition", { state: "running" }),
    event(4, "event:commentary", "assistant_intent", { text: "I believe the token is confirmed." }),
    event(5, "event:partial", "task_partial", {
      taskResult: {
        summary: "Confirmed internal admin token and paused for replanning",
        evidenceRefs: ["event:commentary", "event:evidence:1", "event:evidence:2"],
        artifactRefs: ["artifact:terminal-proof"],
        capabilityRefs: ["connection:ssh-1", "route:internal"]
      }
    })
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.kind, "task_outcome");
  assert.match(observations[0]?.outcomeDigest ?? "", /internal admin token/);
  assert.deepEqual(observations[0]?.sourceEventIds, ["event:partial", "event:evidence:1", "event:evidence:2"]);
  assert.deepEqual(observations[0]?.artifactRefs, ["artifact:terminal-proof"]);
  assert.deepEqual(observations[0]?.capabilityRefs, ["connection:ssh-1", "route:internal"]);
});

test("preserves typed connectivity facts for Projector-owned topology", () => {
  const observations = buildProjectionObservations([
    event(1, "event:session", "connectivity_observation", {
      observationKind: "session",
      transition: "opened",
      connectionRef: "connection:ssh-1",
      hostRef: "host:dmz",
      dialAddress: "192.0.2.23",
      status: "live"
    }),
    event(2, "event:route", "connectivity_observation", {
      observationKind: "route",
      transition: "opened",
      routeRef: "route:internal",
      connectionRef: "connection:ssh-1",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      status: "live"
    })
  ]);

  assert.equal(observations.length, 2);
  assert.equal(observations[0]?.kind, "connectivity");
  assert.deepEqual(observations[0]?.anchors, [
    "connection:ssh-1",
    "host:dmz",
    "192.0.2.23"
  ]);
  assert.deepEqual(observations[1]?.anchors, [
    "route:internal",
    "connection:ssh-1",
    "host:dmz",
    "172.31.0.0/24"
  ]);
});

test("preserves the final conclusion of long tool results", () => {
  const observations = buildProjectionObservations([
    event(1, "event:start", "tool_started", {
      toolCallId: "call:scan",
      toolName: "bash",
      args: { command: `${"scan-candidate ".repeat(40)}exact-final-expression` }
    }),
    event(2, "event:end", "tool_finished", {
      toolCallId: "call:scan",
      toolName: "bash",
      result: { content: [{ type: "text", text: `${"candidate-output ".repeat(80)}No match found` }] }
    })
  ]);

  assert.match(observations[0]?.outcomeDigest ?? "", /^candidate-output/);
  assert.match(observations[0]?.outcomeDigest ?? "", /No match found$/);
  assert.match(observations[0]?.inputDigest ?? "", /exact-final-expression/);
});

test("keeps complete persisted tool material authoritative over Executor interpretation", () => {
  const exactMechanism = "posix_mknod($path, 06000 | 0666, $device)";
  const command = `${"setup;".repeat(100)}${exactMechanism}\n${";cleanup".repeat(100)}`;
  const observations = buildProjectionObservations([
    event(1, "event:intent", "assistant_intent", {
      text: "创建并检查块设备节点",
      toolCalls: [{ id: "call:mechanism", name: "bash", arguments: {} }]
    }),
    event(2, "event:start", "tool_started", {
      toolCallId: "call:mechanism",
      toolName: "bash",
      args: { command }
    }),
    event(3, "event:end", "tool_finished", {
      toolCallId: "call:mechanism",
      toolName: "bash",
      result: { content: [{ type: "text", text: "stat_mode=106644\nstat_mode_after=106600" }] }
    }),
    event(4, "event:interpretation", "assistant_intent", {
      text: "块设备节点已成功创建，重新打开此前被反驳的机制。"
    })
  ]);

  assert.equal(observations[0]?.materialIntegrity?.input, "complete");
  assert.equal(observations[0]?.materialIntegrity?.outcome, "complete");
  assert.equal(observations[0]?.inputDigest, JSON.stringify({ command }));
  assert.equal(observations[0]?.outcomeDigest, "stat_mode=106644\nstat_mode_after=106600");
  const rendered = renderProjectionObservations(observations);
  assert.match(rendered, /material_integrity: input=complete outcome=complete/);
  assert.match(rendered, /executor_commentary_non_evidence:/);
});

test("marks material truncated only when the unified Projector byte budget compacts it", () => {
  const observations = buildProjectionObservations([
    event(1, "event:start", "tool_started", {
      toolCallId: "call:large",
      toolName: "bash",
      args: { command: `head-${"input-material-".repeat(300)}-tail` }
    }),
    event(2, "event:end", "tool_finished", {
      toolCallId: "call:large",
      toolName: "bash",
      result: { content: [{ type: "text", text: `head-${"output-material-".repeat(300)}-tail` }] }
    }),
    event(3, "event:interpretation", "assistant_intent", { text: "机制已确认。" })
  ]);
  const compacted = compactProjectionBatchForInput({
    observations,
    toSeq: 3,
    sourceEventIds: observations[0]!.sourceEventIds
  }, { maxObservations: 1, maxBytes: 900 });

  assert.equal(compacted.observations[0]?.materialIntegrity?.input, "truncated");
  assert.equal(compacted.observations[0]?.materialIntegrity?.outcome, "truncated");
  assert.match(renderProjectionObservations(compacted.observations), /material_integrity: input=truncated outcome=truncated/);
});

test("propagates tool-native truncation metadata into Projector material integrity", () => {
  const observations = buildProjectionObservations([
    event(1, "event:start", "tool_started", {
      toolCallId: "call:truncated",
      toolName: "bash",
      args: { command: "produce bounded output" }
    }),
    event(2, "event:end", "tool_finished", {
      toolCallId: "call:truncated",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "visible prefix and suffix" }],
        details: { truncation: { truncated: true, originalBytes: 100_000 } }
      }
    }),
    event(3, "event:interpretation", "assistant_intent", { text: "输出证明机制成立。" })
  ]);

  assert.equal(observations[0]?.materialIntegrity?.input, "complete");
  assert.equal(observations[0]?.materialIntegrity?.outcome, "truncated");
});

test("coalesces consecutive repeated observations without losing event provenance", () => {
  const observations = buildProjectionObservations([
    event(1, "event:start-1", "tool_started", {
      toolCallId: "call:1",
      toolName: "bash",
      args: { command: "probe candidate-a" }
    }),
    event(2, "event:end-1", "tool_finished", {
      toolCallId: "call:1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "HTTP 403 access denied" }] }
    }),
    event(3, "event:start-2", "tool_started", {
      toolCallId: "call:2",
      toolName: "bash",
      args: { command: "probe candidate-b" }
    }),
    event(4, "event:end-2", "tool_finished", {
      toolCallId: "call:2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "HTTP 403 access denied" }] }
    })
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.repeatCount, 2);
  assert.deepEqual(observations[0]?.sourceEventIds, [
    "event:start-1", "event:end-1", "event:start-2", "event:end-2"
  ]);
  assert.match(observations[0]?.inputDigest ?? "", /candidate-a/);
  assert.match(observations[0]?.inputDigest ?? "", /candidate-b/);
});

test("expands graph aliases and observation evidence refs into stable GraphDelta ids", () => {
  const nodes: GraphNode[] = [{
    id: "endpoint:upload",
    graphKind: "operation",
    type: "WebEndpoint",
    label: "POST /api/upload.php",
    properties: { method: "POST", path: "/api/upload.php" }
  }];
  const edges: GraphEdge[] = [];
  const graphContext = aliasProjectionGraphContext({ nodes, edges });
  const batch = {
    observations: [{
      ref: "o1",
      kind: "action" as const,
      seqStart: 1,
      seqEnd: 3,
      action: "bash",
      outcomeDigest: "API key accepted and upload succeeded",
      status: "ok" as const,
      artifactRefs: [],
      anchors: ["/api/upload.php"],
      sourceEventIds: ["event:1", "event:2", "event:3"]
    }],
    toSeq: 3,
    sourceEventIds: ["event:1", "event:2", "event:3"]
  };

  const delta = expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        type: "Vulnerability",
        label: "Hardcoded API key grants upload access",
        properties: { status: "confirmed" },
        evidenceRefs: ["o1"]
      }],
      edges: [{
        from: "new:1",
        to: "existing:1",
        type: "affects",
        evidenceRefs: ["o1"]
      }]
    }
  });

  assert.deepEqual(delta.sourceEventIds, ["event:1", "event:2", "event:3"]);
  assert.equal(delta.nodes[0]?.graphKind, "reasoning");
  assert.deepEqual(delta.nodes[0]?.evidenceRefs, ["event:1", "event:2", "event:3"]);
  assert.equal(delta.edges[0]?.to, "endpoint:upload");
  assert.deepEqual(delta.edges[0]?.evidenceRefs, ["event:1", "event:2", "event:3"]);
  assert.match(renderProjectionGraphContext(graphContext), /existing:1 operation\/WebEndpoint/);
});

test("filters task and scope nodes before building Projector-visible graph context", () => {
  const filtered = filterProjectorSemanticGraph({
    nodes: [{
      id: "task:read-flag",
      graphKind: "task",
      type: "Task",
      label: "Read flag",
      properties: {}
    }, {
      id: "scope:root",
      graphKind: "task",
      type: "Scope",
      label: "Authorized scope",
      properties: {}
    }, {
      id: "endpoint:flag",
      graphKind: "operation",
      type: "WebEndpoint",
      label: "GET /flag",
      properties: { path: "/flag" }
    }, {
      id: "evidence:flag",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Flag response",
      properties: {}
    }],
    edges: [{
      from: "task:read-flag",
      to: "endpoint:flag",
      type: "requires_evidence"
    }, {
      from: "task:read-flag",
      to: "scope:root",
      type: "within_scope"
    }, {
      from: "evidence:flag",
      to: "endpoint:flag",
      type: "observed_on"
    }]
  });

  assert.deepEqual(filtered.nodes.map((node) => node.id), ["endpoint:flag", "evidence:flag"]);
  assert.deepEqual(filtered.edges, [{
    from: "evidence:flag",
    to: "endpoint:flag",
    type: "observed_on"
  }]);
  const graphContext = aliasProjectionGraphContext(filtered);
  assert.doesNotMatch(renderProjectionGraphContext(graphContext), /task\/|Task|Scope|task:|scope:/);
});

test("projector rejects task graph mutations atomically", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{
      id: "task:read-flag",
      graphKind: "task",
      type: "Task",
      label: "Read flag",
      properties: { status: "partial" }
    }],
    edges: []
  });
  assert.throws(() => expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "task_outcome",
        seqStart: 1,
        seqEnd: 1,
        outcomeDigest: "Flag is not yet available",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:1"]
      }],
      toSeq: 1,
      sourceEventIds: ["event:1"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "existing:1",
        properties: { status: "blocked" },
        evidenceRefs: ["o1"]
      }],
      edges: []
    }
  }), /cannot mutate task graph aliases existing:1\(Task\); no part of the delta was accepted/i);
  assert.throws(() => expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "task_outcome",
        seqStart: 1,
        seqEnd: 1,
        outcomeDigest: "Flag is not yet available",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:1"]
      }],
      toSeq: 1,
      sourceEventIds: ["event:1"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        type: "Host",
        label: "Flag host",
        properties: {},
        evidenceRefs: ["o1"]
      }],
      edges: [{ from: "existing:1", to: "new:1", type: "observed_on", evidenceRefs: ["o1"] }]
    }
  }), /cannot mutate task graph aliases existing:1\(Task\); no part of the delta was accepted/i);
});

test("rejects unknown edge aliases instead of silently dropping relationships", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  assert.throws(() => expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "action",
        seqStart: 1,
        seqEnd: 1,
        action: "bash",
        outcomeDigest: "Observed a relationship",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:1"]
      }],
      toSeq: 1,
      sourceEventIds: ["event:1"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        type: "Evidence",
        label: "Observed evidence",
        evidenceRefs: ["o1"]
      }],
      edges: [{ from: "new:1", to: "existing:2", type: "supports", evidenceRefs: ["o1"] }]
    }
  }), /unknown existing alias/);
});

test("rejects malformed projection drafts with actionable per-node and per-edge messages", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const batch = {
    observations: [{
      ref: "o1",
      kind: "action" as const,
      seqStart: 1,
      seqEnd: 1,
      action: "bash",
      outcomeDigest: "Observed evidence",
      status: "ok" as const,
      artifactRefs: [],
      anchors: [],
      sourceEventIds: ["event:1"]
    }],
    toSeq: 1,
    sourceEventIds: ["event:1"]
  };
  const baseNode = {
    id: "new:1",
    type: "Host",
    label: "host.docker.internal:32856",
    properties: {},
    evidenceRefs: ["o1"]
  };

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: { nodes: [{ ...baseNode, status: "active", target: "x" }], edges: [] }
  }), /unexpected top-level keys \[status, target\].*nodes only allow id, type, label, properties, evidenceRefs/);

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: { nodes: [{ ...baseNode, graphKind: "operation" }], edges: [] }
  }), /unexpected top-level keys \[graphKind\].*nodes only allow id, type, label, properties, evidenceRefs/);

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: { nodes: [{ ...baseNode, type: "Endpoint" }], edges: [] }
  }), /has type "Endpoint"; valid node types: Host, Port, Service, WebEndpoint, Parameter, Credential, AgentSession, ShellSession, Session, File, Process, Evidence, Hypothesis, Vulnerability, Exploit/);

  assert.doesNotThrow(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [baseNode],
      edges: []
    }
  }));

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [baseNode],
      edges: [{ from: "new:1", to: "new:1", type: "tunnel_to", evidenceRefs: ["o1"] }]
    }
  }), /edge at index 0 has type "tunnel_to"; for Host -> Host, use "resolves_to"/);
});

test("keeps Hypothesis statuses canonical without conflating contrary evidence with refutation", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const batch = {
    observations: [{
      ref: "o1",
      kind: "action" as const,
      seqStart: 1,
      seqEnd: 1,
      action: "bash",
      outcomeDigest: "The controlled candidate matched the negative baseline",
      status: "ok" as const,
      artifactRefs: [],
      anchors: [],
      sourceEventIds: ["event:negative"]
    }],
    toSeq: 1,
    sourceEventIds: ["event:negative"]
  };
  const evidenceNode = {
    id: "new:1",
    type: "Evidence",
    label: "Candidate matched the negative baseline",
    properties: { observedResult: "same response hash" },
    evidenceRefs: ["o1"]
  };

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [evidenceNode, {
        id: "new:2",
        type: "Hypothesis",
        label: "Candidate reaches the target sink",
        properties: { status: "contradicted" },
        evidenceRefs: ["o1"]
      }],
      edges: [{ from: "new:1", to: "new:2", type: "contradicts", evidenceRefs: ["o1"] }]
    }
  }), /Hypothesis.*invalid status "contradicted"/);

  assert.doesNotThrow(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [evidenceNode, {
        id: "new:2",
        type: "Hypothesis",
        label: "Candidate reaches the target sink",
        properties: { status: "inconclusive" },
        evidenceRefs: ["o1"]
      }],
      edges: [{ from: "new:1", to: "new:2", type: "contradicts", evidenceRefs: ["o1"] }]
    }
  }));

  assert.doesNotThrow(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [evidenceNode, {
        id: "new:2",
        type: "Hypothesis",
        label: "Candidate reaches the target sink",
        properties: {
          status: "refuted",
          negativeConclusion: "Under the tested transform, the candidate is indistinguishable from the negative baseline"
        },
        evidenceRefs: ["o1"]
      }],
      edges: [{ from: "new:1", to: "new:2", type: "contradicts", evidenceRefs: ["o1"] }]
    }
  }));
});

test("reports all projection draft errors together with endpoint-aware edge suggestions", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const batch = {
    observations: [{
      ref: "o1",
      kind: "action" as const,
      seqStart: 1,
      seqEnd: 1,
      action: "bash",
      outcomeDigest: "Observed service and endpoint",
      status: "ok" as const,
      artifactRefs: [],
      anchors: [],
      sourceEventIds: ["event:1"]
    }],
    toSeq: 1,
    sourceEventIds: ["event:1"]
  };

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        type: "Service",
        label: "HTTP service",
        properties: {}
      }, {
        id: "new:2",
        type: "WebEndpoint",
        label: "GET /",
        properties: {},
        artifactRefs: ["artifact:test"]
      }, {
        id: "new:3",
        type: "Evidence",
        label: "Unconnected evidence",
        properties: {},
        evidenceRefs: ["o1"]
      }],
      edges: [{
        from: "new:1",
        to: "new:2",
        type: "serves_endpoint",
        evidenceRefs: ["o1"]
      }]
    }
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /has 1 validation error/);
    assert.match(error.message, /for Service -> WebEndpoint, use "exposes_endpoint"/);
    return true;
  });
});

test("rejects Vulnerability and succeeded Exploit drafts without resolvable evidence", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const batch = {
    observations: [{
      ref: "o1",
      kind: "action" as const,
      seqStart: 1,
      seqEnd: 1,
      action: "bash",
      outcomeDigest: "Observed exploit evidence",
      status: "ok" as const,
      artifactRefs: [],
      anchors: [],
      sourceEventIds: ["event:1"]
    }],
    toSeq: 1,
    sourceEventIds: ["event:1"]
  };

  assert.throws(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        type: "Vulnerability",
        label: "Confirmed issue",
        properties: { status: "confirmed" },
        evidenceRefs: ["o-missing"]
      }, {
        id: "new:2",
        type: "Exploit",
        label: "Successful exploit",
        properties: { status: "succeeded" },
        evidenceRefs: []
      }],
      edges: [{
        from: "new:1",
        to: "new:2",
        type: "exploited_by",
        evidenceRefs: ["o1"]
      }]
    }
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /has 2 validation errors/);
    assert.match(error.message, /Vulnerability.*must include at least one evidenceRef/);
    assert.match(error.message, /succeeded Exploit.*must include at least one evidenceRef/);
    return true;
  });

  assert.doesNotThrow(() => expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes: [{
        id: "new:1",
        type: "Vulnerability",
        label: "Confirmed issue",
        properties: { status: "confirmed" },
        evidenceRefs: ["o1"]
      }, {
        id: "new:2",
        type: "Exploit",
        label: "Successful exploit",
        properties: { status: "succeeded" },
        evidenceRefs: ["event:1"]
      }],
      edges: [{
        from: "new:1",
        to: "new:2",
        type: "exploited_by",
        evidenceRefs: ["o1"]
      }]
    }
  }));
});

test("accepts large Projector closures within the total byte boundary", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const batch = { observations: [], toSeq: 0, sourceEventIds: [] };
  const nodes = Array.from({ length: 42 }, (_, index) => ({
    id: `new:${index + 1}`,
    type: "Evidence",
    label: `Evidence ${index + 1}`
  }));
  const delta = expandProjectionDraft({
    batch,
    graphContext,
    value: {
      nodes,
      edges: Array.from({ length: 41 }, (_, index) => ({
        from: `new:${index + 1}`,
        to: `new:${index + 2}`,
        type: "supports"
      }))
    }
  });
  assert.equal(delta.nodes.length, 42);
  assert.equal(delta.edges.length, 41);
});

test("updates existing semantic nodes while preserving their identity", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{
      id: "evidence:access-denied",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Access denied",
      properties: { count: 1 },
      evidenceRefs: ["event:old"]
    }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "action",
        seqStart: 1,
        seqEnd: 2,
        action: "bash",
        outcomeDigest: "A second request was denied",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:new"]
      }],
      toSeq: 2,
      sourceEventIds: ["event:new"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "existing:1",
        properties: { count: 2 },
        evidenceRefs: ["o1"]
      }],
      edges: []
    }
  });

  assert.deepEqual(delta.nodes, [{
    id: "evidence:access-denied",
    graphKind: "reasoning",
    type: "Evidence",
    label: "Access denied",
    properties: { count: 2 },
    evidenceRefs: ["event:new"]
  }]);
});

test("normalizes natural top-level Projector artifact references into node properties", () => {
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext: aliasProjectionGraphContext({ nodes: [], edges: [] }),
    value: {
      nodes: [{
        id: "new:1",
        type: "File",
        label: "Reusable PoC",
        artifactRef: "artifact:poc",
        artifactRefs: ["artifact:trace", "artifact:poc"]
      }],
      edges: []
    }
  });

  assert.deepEqual(delta.nodes[0]?.properties.artifactRefs, ["artifact:poc", "artifact:trace"]);
  assert.equal(delta.nodes[0]?.properties.artifactRef, undefined);
});

test("new projector aliases receive runtime identities instead of colliding with graph ids", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{
      id: "new:13",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Pre-existing semantic id",
      properties: {},
      evidenceRefs: ["event:old"]
    }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: {
      observations: [{
        ref: "o1",
        kind: "action",
        seqStart: 1,
        seqEnd: 1,
        action: "bash",
        outcomeDigest: "Observed a new endpoint",
        status: "ok",
        artifactRefs: [],
        anchors: [],
        sourceEventIds: ["event:new"]
      }],
      toSeq: 1,
      sourceEventIds: ["event:new"]
    },
    graphContext,
    value: {
      nodes: [{
        id: "new:13",
        type: "WebEndpoint",
        label: "/admin",
        properties: { method: "GET" },
        evidenceRefs: ["o1"]
      }],
      edges: []
    }
  });

  assert.equal(delta.nodes.length, 1);
  assert.match(delta.nodes[0]?.id ?? "", /^projected:/);
  assert.notEqual(delta.nodes[0]?.id, "new:13");
});

test("projector rejects explicit global ids outside the alias boundary atomically", () => {
  assert.throws(() => expandProjectionDraft({
    batch: {
      observations: [],
      toSeq: 0,
      sourceEventIds: []
    },
    graphContext: aliasProjectionGraphContext({ nodes: [], edges: [] }),
    value: {
      nodes: [{
        id: "evidence:model-chosen-global-id",
        type: "Evidence",
        label: "Invalid identity",
        properties: {}
      }],
      edges: []
    }
  }), /invalid alias evidence:model-chosen-global-id; no part of the delta was accepted/i);
});

test("planner observation digest preserves task outcomes and diverse earlier findings", () => {
  const observations: ProjectionObservation[] = Array.from({ length: 10 }, (_, index) => ({
    ref: `o${index + 1}`,
    kind: "action" as const,
    seqStart: index * 3 + 1,
    seqEnd: index * 3 + 3,
    intent: `intent ${index + 1}`,
    action: "bash",
    outcomeDigest: index === 2 ? "confirmed arbitrary file read" : `routine probe ${index + 1}`,
    status: "ok" as const,
    artifactRefs: [],
    anchors: index === 2 ? ["/sensitive/file"] : [],
    sourceEventIds: [`event:${index + 1}`]
  }));
  observations.push({
    ref: "o11",
    kind: "task_outcome",
    seqStart: 31,
    seqEnd: 31,
    outcomeDigest: "phase result confirms reusable file-read capability",
    status: "ok",
    artifactRefs: [],
    anchors: ["/sensitive/file"],
    sourceEventIds: ["event:11"]
  });

  const digest = observationDigest(observations, 1200);

  assert.match(digest, /confirmed arbitrary file read/);
  assert.match(digest, /phase result confirms reusable file-read capability/);
  assert.ok(digest.split("\n").length <= 6);
});

test("projection compaction advances only through the continuous prefix shown to the model", () => {
  const observations: ProjectionObservation[] = Array.from({ length: 4 }, (_, index) => ({
    ref: `original:${index + 1}`,
    kind: index === 3 ? "task_outcome" : "action",
    seqStart: index * 2 + 1,
    seqEnd: index * 2 + 2,
    action: index === 3 ? undefined : "bash",
    executorCommentary: index === 3 ? undefined : `commentary ${index + 1}`,
    readyForProjection: index === 3 ? undefined : true,
    outcomeDigest: `${"large body ".repeat(100)}result ${index + 1}`,
    status: index === 3 ? "error" : "ok",
    artifactRefs: [`artifact:${index + 1}`],
    anchors: [`10.0.0.${index + 1}`, `/path/${index + 1}`],
    sourceEventIds: [`event:${index * 2 + 1}`, `event:${index * 2 + 2}`]
  }));

  const compacted = compactProjectionBatchForInput({
    observations,
    toSeq: 12,
    sourceEventIds: observations.flatMap((observation) => observation.sourceEventIds)
  }, {
    maxObservations: 2,
    maxBytes: 2_000
  });

  assert.equal(compacted.observations.length, 2);
  assert.equal(compacted.toSeq, 4);
  assert.deepEqual(compacted.sourceEventIds, ["event:1", "event:2", "event:3", "event:4"]);
  assert.equal(compacted.observations.some((observation) => observation.kind === "task_outcome"), false);
  assert.doesNotMatch(renderProjectionObservations(compacted.observations), /result 3|result 4/);
});

test("projection compaction preserves structural facts for an oversized observation", () => {
  const artifactRefs = Array.from({ length: 12 }, (_, index) => `artifact:${index + 1}`);
  const anchors = Array.from({ length: 16 }, (_, index) => `172.31.0.${index + 1}`);
  const sourceEventIds = Array.from({ length: 20 }, (_, index) => `event:${index + 1}`);
  const actions = Array.from({ length: 10 }, (_, index) => ({
    action: `tool-${index + 1}`,
    inputDigest: `input ${index + 1} ${"x".repeat(500)}`,
    outcomeDigest: `outcome ${index + 1} ${"y".repeat(500)}`,
    status: "ok" as const
  }));
  const compacted = compactProjectionBatchForInput({
    observations: [{
      ref: "original:1",
      kind: "task_outcome",
      seqStart: 1,
      seqEnd: 20,
      outcomeDigest: `terminal outcome ${"z".repeat(5_000)}`,
      status: "error",
      artifactRefs,
      anchors,
      sourceEventIds,
      actions
    }],
    toSeq: 25,
    sourceEventIds
  }, {
    maxObservations: 1,
    maxBytes: 800
  });

  assert.equal(compacted.toSeq, 25);
  assert.equal(compacted.observations[0]?.status, "error");
  assert.deepEqual(compacted.observations[0]?.artifactRefs, artifactRefs);
  assert.deepEqual(compacted.observations[0]?.anchors, anchors);
  assert.deepEqual(compacted.observations[0]?.sourceEventIds, sourceEventIds);
  assert.equal(compacted.observations[0]?.actions?.length, actions.length);
  const rendered = renderProjectionObservations(compacted.observations);
  assert.match(rendered, /artifact:12/);
  assert.match(rendered, /172\.31\.0\.16/);
  assert.match(rendered, /tool\[10\]: tool-10/);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 800);
});

test("projection compaction measures multibyte text in UTF-8 bytes", () => {
  const compacted = compactProjectionBatchForInput({
    observations: [{
      ref: "original:1",
      kind: "task_outcome",
      seqStart: 10,
      seqEnd: 10,
      outcomeDigest: `确认结论 ${"内网证据".repeat(2_000)} 最终标记`,
      status: "ok",
      artifactRefs: ["artifact:proof"],
      anchors: ["172.31.0.20", "/flag.html"],
      sourceEventIds: ["event:outcome"]
    }],
    toSeq: 12,
    sourceEventIds: ["event:outcome", "event:non-semantic-tail"]
  }, {
    maxObservations: 1,
    maxBytes: 512
  });

  const rendered = renderProjectionObservations(compacted.observations);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 512);
  assert.equal(compacted.toSeq, 12);
  assert.equal(compacted.observations[0]?.status, "ok");
  assert.deepEqual(compacted.observations[0]?.artifactRefs, ["artifact:proof"]);
  assert.deepEqual(compacted.observations[0]?.anchors, ["172.31.0.20", "/flag.html"]);
  assert.deepEqual(compacted.observations[0]?.sourceEventIds, ["event:outcome"]);
  assert.deepEqual(compacted.sourceEventIds, ["event:outcome", "event:non-semantic-tail"]);
});

test("partitions one huge grouped observation without losing structure or provenance", () => {
  const events: ExecutionEvent[] = [
    event(1, "event:intent", "assistant_intent", {
      text: "并行验证全部候选服务",
      toolCalls: Array.from({ length: 80 }, (_, index) => ({
        id: `call:${index}`,
        name: "bash",
        arguments: {}
      }))
    })
  ];
  for (let index = 0; index < 80; index += 1) {
    events.push(event(index + 2, `event:start-${index}`, "tool_started", {
      toolCallId: `call:${index}`,
      toolName: "bash",
      args: { command: `curl http://10.0.0.${index + 1}/path/${index}` }
    }));
  }
  for (let index = 0; index < 80; index += 1) {
    events.push(event(index + 82, `event:end-${index}`, "tool_finished", {
      toolCallId: `call:${index}`,
      toolName: "bash",
      artifactRef: `artifact:${index}`,
      result: { content: [{ type: "text", text: `HTTP 200 from 10.0.0.${index + 1}` }] }
    }));
  }
  events.push(event(162, "event:interpretation", "assistant_intent", {
    text: "全部候选完成验证，保留每个目标的独立证据。"
  }));

  const [grouped] = buildProjectionObservations(events);
  assert.equal(grouped?.actions?.length, 80);
  const batch = {
    observations: [grouped!],
    toSeq: 162,
    sourceEventIds: [...grouped!.sourceEventIds, "event:non-semantic-tail"]
  };
  const chunks = partitionProjectionBatchForInput(batch, {
    maxObservations: 4,
    maxBytes: 1_200
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(
    renderProjectionObservations(chunk.observations),
    "utf8"
  ) <= 1_200));
  assert.equal(chunks.flatMap((chunk) => chunk.observations)
    .flatMap((observation) => observation.actions ?? []).length, 80);
  assert.deepEqual(
    new Set(chunks.flatMap((chunk) => chunk.sourceEventIds)),
    new Set(batch.sourceEventIds)
  );
  assert.deepEqual(
    new Set(chunks.flatMap((chunk) => chunk.observations).flatMap((observation) => observation.artifactRefs)),
    new Set(grouped!.artifactRefs)
  );
  assert.deepEqual(
    new Set(chunks.flatMap((chunk) => chunk.observations).flatMap((observation) => observation.anchors)),
    new Set(grouped!.anchors)
  );
  assert.ok(chunks.flatMap((chunk) => chunk.observations)
    .every((observation) => observation.status === grouped!.status));
});

test("rejects an irreducible projection envelope instead of returning an oversized batch", () => {
  const oversizedRef = `artifact:${"x".repeat(2_000)}`;
  assert.throws(() => compactProjectionBatchForInput({
    observations: [{
      ref: "o1",
      kind: "task_outcome",
      seqStart: 1,
      seqEnd: 1,
      outcomeDigest: "completed",
      status: "ok",
      artifactRefs: [oversizedRef],
      anchors: [],
      sourceEventIds: ["event:1"]
    }],
    toSeq: 1,
    sourceEventIds: ["event:1"]
  }, {
    maxObservations: 1,
    maxBytes: 512
  }), /Projection observation envelope requires .* maximum is 512/);
});

test("normalization bounds repeated coalescing without losing provenance", () => {
  const repeatedEvents: ExecutionEvent[] = [];
  for (let index = 0; index < 40; index += 1) {
    repeatedEvents.push(
      event(index * 2 + 1, `event:start-${index}`, "tool_started", {
        toolCallId: `call:${index}`,
        toolName: "bash",
        args: { command: "same probe" }
      }),
      event(index * 2 + 2, `event:end-${index}`, "tool_finished", {
        toolCallId: `call:${index}`,
        toolName: "bash",
        result: { content: [{ type: "text", text: "HTTP 403 access denied" }] }
      })
    );
  }
  repeatedEvents.push(event(81, "event:commentary", "assistant_intent", {
    text: "这些相同探测均返回 HTTP 403。"
  }));
  const repeated = buildProjectionObservations(repeatedEvents);
  assert.equal(repeated.length, 3);
  assert.ok(repeated.every((observation) => (observation.repeatCount ?? 1) <= 16));
  assert.deepEqual(
    repeated.flatMap((observation) => observation.sourceEventIds),
    repeatedEvents.slice(0, -1).map((item) => item.id)
  );
  const firstBatch = selectProjectionBatch(repeatedEvents, { fromSeq: 0, maxObservations: 1 });
  assert.equal(firstBatch.toSeq, 32);
  assert.deepEqual(firstBatch.sourceEventIds, repeatedEvents.slice(0, 32).map((item) => item.id));
});

test("observation normalization retains every discovered anchor", () => {
  const observations = buildProjectionObservations([
    event(1, "event:result", "tool_finished", {
      toolCallId: "call:scan",
      toolName: "bash",
      result: {
        content: [{
          type: "text",
          text: "10.0.0.1 10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 10.0.0.6"
        }]
      }
    })
  ]);

  assert.deepEqual(observations[0]?.anchors, [
    "10.0.0.1",
    "10.0.0.2",
    "10.0.0.3",
    "10.0.0.4",
    "10.0.0.5",
    "10.0.0.6"
  ]);
});

test("planner observation digest renders the latest task outcome before older actions", () => {
  const digest = observationDigest([
    {
      ref: "o1",
      kind: "action",
      seqStart: 1,
      seqEnd: 2,
      action: "bash",
      inputDigest: "enumerate many routine paths",
      outcomeDigest: "routine path enumeration returned no match",
      status: "ok",
      artifactRefs: [],
      anchors: ["/routine"],
      sourceEventIds: ["event:1", "event:2"]
    },
    {
      ref: "o2",
      kind: "task_outcome",
      seqStart: 3,
      seqEnd: 3,
      outcomeDigest: "Confirmed admin_token=internal_admin_token_2024 from the internal configuration endpoint",
      status: "ok",
      artifactRefs: [],
      anchors: ["/debug/config"],
      sourceEventIds: ["event:3"]
    }
  ], 180);

  assert.match(digest, /^o2:task_outcome:ok/);
  assert.match(digest, /admin_token=internal_admin_token_2024/);
});

test("capability digest preserves reusable action input and outcome", () => {
  const digest = capabilityDigest([{
    ref: "o1",
    kind: "action",
    seqStart: 1,
    seqEnd: 2,
    action: "bash",
    inputDigest: "curl -H 'X-Api-Key: key' /upload",
    outcomeDigest: "Upload accepted and stored at /files/poc.php",
    status: "ok",
    artifactRefs: ["artifact:poc"],
    anchors: ["/upload"],
    sourceEventIds: ["event:1", "event:2"]
  }]);

  assert.match(digest, /X-Api-Key/);
  assert.match(digest, /stored at \/files\/poc.php/);
  assert.match(digest, /artifact:poc/);
});

test("projection context preserves parallel edge identities and properties", () => {
  const nodes: GraphNode[] = [
    { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: { host: "a.test" } },
    { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: { host: "b.test" } }
  ];
  const context = aliasProjectionGraphContext({
    nodes,
    edges: [
      { id: "tunnel:first", from: "host:a", to: "host:b", type: "tunnels_to", properties: { tunnelId: "first", status: "live" } },
      { id: "tunnel:second", from: "host:a", to: "host:b", type: "tunnels_to", properties: { tunnelId: "second", status: "degraded" } }
    ]
  });

  assert.equal(context.edges.length, 2);
  assert.deepEqual(context.edges.map((edge) => edge.id), ["tunnel:first", "tunnel:second"]);
  assert.deepEqual(context.edges.map((edge) => edge.properties.tunnelId), ["first", "second"]);
  assert.match(renderProjectionGraphContext(context), /"tunnelId":"first"/);
  assert.match(renderProjectionGraphContext(context), /"status":"degraded"/);
});

test("projection graph context compaction keeps complete records and aligned aliases", () => {
  const context = aliasProjectionGraphContext({
    nodes: Array.from({ length: 20 }, (_, index): GraphNode => ({
      id: `host:${index}`,
      graphKind: "operation",
      type: "Host",
      label: `host-${index}-${"label".repeat(30)}`,
      properties: { host: `10.0.0.${index + 1}`, resultSummary: "summary".repeat(40) }
    })),
    edges: Array.from({ length: 19 }, (_, index): GraphEdge => ({
      from: `host:${index}`,
      to: `host:${index + 1}`,
      type: "reachable_from",
      properties: { via: `route-${index}` }
    }))
  });

  const compacted = compactProjectionGraphContextForInput(context, 2_000);
  const rendered = renderProjectionGraphContext(compacted);

  assert.ok(Buffer.byteLength(rendered, "utf8") <= 2_000);
  assert.ok(compacted.nodes.length > 0 && compacted.nodes.length < context.nodes.length);
  assert.equal(compacted.nodeAliases.size, compacted.nodes.length);
  assert.ok(compacted.edges.every((edge) => (
    compacted.nodeAliases.has(edge.from) && compacted.nodeAliases.has(edge.to)
  )));
  assert.match(rendered, /byte view omitted nodes=/);
});

test("projector leaves operational edge identity to GraphStore after alias resolution", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: { host: "a.test" } },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: { host: "b.test" } },
      { id: "host:c", graphKind: "operation", type: "Host", label: "C", properties: { host: "c.test" } }
    ],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    value: {
      nodes: [],
      edges: [
        { from: "existing:1", to: "existing:2", type: "tunnels_to", properties: { tunnelId: "ssh / primary", transport: "ssh" } },
        { from: "existing:1", to: "existing:2", type: "proxy_route", properties: { routeId: "route #1", via: "127.0.0.1:8080" } },
        { from: "existing:1", to: "existing:3", type: "proxy_route", properties: { routeId: "route #1", via: "127.0.0.1:8080" } }
      ]
    }
  });

  assert.deepEqual(delta.edges.map((edge) => edge.id), [undefined, undefined, undefined]);
  assert.deepEqual(delta.edges.map((edge) => [edge.from, edge.to]), [
    ["host:a", "host:b"],
    ["host:a", "host:b"],
    ["host:a", "host:c"]
  ]);
  assert.equal(delta.edges[0]?.properties?.transport, "ssh");
  assert.equal(delta.edges[1]?.properties?.via, "127.0.0.1:8080");
});

test("canonical operation identities cover agent and shell sessions", () => {
  const graphContext = aliasProjectionGraphContext({ nodes: [], edges: [] });
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    value: {
      nodes: [
        { id: "new:1", type: "AgentSession", label: "Renamed agent", properties: { agentSessionId: "agent-1" } },
        { id: "new:2", type: "ShellSession", label: "Renamed shell", properties: { sessionId: "shell-1" } }
      ],
      edges: []
    }
  });

  assert.deepEqual(delta.nodes.map((node) => node.id), ["agent-session:agent-1", "shell-session:shell-1"]);
});

test("session labels without business ids do not determine identity", () => {
  const graphContext = aliasProjectionGraphContext({
    nodes: [{ id: "agent-session:existing", graphKind: "operation", type: "AgentSession", label: "Shared label", properties: {} }],
    edges: []
  });
  const delta = expandProjectionDraft({
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    value: {
      nodes: [
        { id: "new:1", type: "AgentSession", label: "Shared label", properties: {} },
        { id: "new:2", type: "AgentSession", label: "Shared label", properties: {} }
      ],
      edges: []
    }
  });

  assert.equal(delta.nodes.length, 2);
  assert.ok(delta.nodes.every((node) => node.id.startsWith("projected:")));
  assert.notEqual(delta.nodes[0]?.id, delta.nodes[1]?.id);
  assert.ok(delta.nodes.every((node) => node.id !== "agent-session:existing"));
});

function event(seq: number, id: string, eventType: string, payload: Record<string, unknown>): ExecutionEvent {
  return {
    id,
    seq,
    taskId: "task:test",
    role: "executor",
    eventType,
    timestamp: new Date(0).toISOString(),
    payload
  };
}
