import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GraphValidationError, PlannerDecisionConflict, SQLiteGraphStore } from "../src/stores/graph-store.js";
import { RuntimeStore } from "../src/stores/runtime-store.js";

test("upserts tri-graph nodes and reads planner view", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:1"],
    nodes: [
      {
        id: "evidence:http-login",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Login page returned 200",
        properties: { statusCode: 200 },
        evidenceRefs: ["event:1"]
      },
      {
        id: "endpoint:/login",
        graphKind: "operation",
        type: "WebEndpoint",
        label: "POST /login",
        properties: { method: "POST", path: "/login" }
      },
      {
        id: "task:enumerate",
        graphKind: "task",
        type: "Task",
        label: "Enumerate login surface",
        properties: { status: "open" }
      }
    ],
    edges: [
      { from: "evidence:http-login", to: "endpoint:/login", type: "observed_on", evidenceRefs: ["event:1"] }
    ]
  });
  const snapshot = graphStore.query("planner");
  assert.equal(snapshot.summary.nodeCount, 3);
  assert.equal(snapshot.edges.length, 1);
  assert.deepEqual(graphStore.stats(), {
    nodeCount: 3,
    edgeCount: 1,
    deltaCount: 1,
    evidenceBackedNodeCount: 1,
    evidenceBackedEdgeCount: 1,
    nodesByKind: { operation: 1, reasoning: 1, task: 1 }
  });
  graphStore.close();
});

test("graph trace returns an empty snapshot for empty or unknown focus", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:unrelated"],
    nodes: [{
      id: "node:unrelated",
      graphKind: "operation",
      type: "Host",
      label: "Unrelated host",
      properties: { ip: "10.0.0.99" },
      evidenceRefs: ["event:unrelated"]
    }],
    edges: []
  });

  assert.deepEqual(graphStore.trace({}).nodes, []);
  assert.deepEqual(graphStore.trace({}).edges, []);
  assert.deepEqual(graphStore.trace({ nodeId: "node:missing" }).nodes, []);
  assert.deepEqual(graphStore.trace({ nodeId: "node:missing" }).edges, []);
  assert.deepEqual(graphStore.trace({ nodeId: "node:unrelated" }).nodes.map((node) => node.id), ["node:unrelated"]);
  graphStore.close();
});

test("focused graph queries filter neighborhood nodes by graph kind", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:focus"],
    nodes: [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: {} },
      { id: "host:target", graphKind: "operation", type: "Host", label: "Target", properties: {} }
    ],
    edges: [{ from: "goal:root", to: "host:target", type: "observed_on", evidenceRefs: ["event:focus"] }]
  });

  const operation = graphStore.query("operation", ["goal:root"], 10);

  assert.deepEqual(operation.nodes.map((node) => node.id), ["host:target"]);
  assert.ok(operation.nodes.every((node) => node.graphKind === "operation"));
  graphStore.close();
});

test("projection closure preserves operation and reasoning paths around touched anchors", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:chain"],
    nodes: [
      { id: "task:test", graphKind: "task", type: "Task", label: "Upload validation", properties: { status: "open" } },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      { id: "host:target", graphKind: "operation", type: "Host", label: "10.0.0.5", properties: { host: "10.0.0.5" } },
      { id: "port:80", graphKind: "operation", type: "Port", label: "80/tcp", properties: { port: 80 } },
      { id: "service:http", graphKind: "operation", type: "Service", label: "HTTP", properties: { service: "http" } },
      { id: "endpoint:upload", graphKind: "operation", type: "WebEndpoint", label: "POST /api/upload.php", properties: { url: "http://10.0.0.5/api/upload.php" } },
      { id: "evidence:upload", graphKind: "reasoning", type: "Evidence", label: "Upload returned 200", properties: {}, evidenceRefs: ["event:chain"] },
      { id: "hypothesis:handler", graphKind: "reasoning", type: "Hypothesis", label: "Uploaded extension may execute", properties: { status: "open" }, evidenceRefs: ["event:chain"] },
      { id: "vuln:upload", graphKind: "reasoning", type: "Vulnerability", label: "Unsafe upload confirmed", properties: { status: "confirmed" }, evidenceRefs: ["event:chain"] }
    ],
    edges: [
      { from: "task:test", to: "scope:root", type: "within_scope" },
      { from: "task:test", to: "endpoint:upload", type: "requires_evidence" },
      { from: "host:target", to: "port:80", type: "has_port" },
      { from: "port:80", to: "service:http", type: "runs_service" },
      { from: "service:http", to: "endpoint:upload", type: "exposes_endpoint" },
      { from: "evidence:upload", to: "endpoint:upload", type: "observed_on", evidenceRefs: ["event:chain"] },
      { from: "evidence:upload", to: "hypothesis:handler", type: "supports", evidenceRefs: ["event:chain"] },
      { from: "evidence:upload", to: "vuln:upload", type: "confirms", evidenceRefs: ["event:chain"] }
    ]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:test",
    scopeRef: "scope:root",
    targetRefs: ["endpoint:upload"],
    anchors: ["http://10.0.0.5/api/upload.php"]
  });
  const nodeIds = new Set(closure.nodes.map((node) => node.id));
  const edgeTypes = new Set(closure.edges.map((edge) => edge.type));

  for (const nodeId of [
    "host:target", "port:80", "service:http", "endpoint:upload",
    "evidence:upload", "hypothesis:handler", "vuln:upload"
  ]) {
    assert.ok(nodeIds.has(nodeId), `missing closure node ${nodeId}`);
  }
  for (const edgeType of ["has_port", "runs_service", "exposes_endpoint", "observed_on", "supports", "confirms"]) {
    assert.ok(edgeTypes.has(edgeType), `missing closure edge ${edgeType}`);
  }
  graphStore.close();
});

test("rejects non-canonical and ungrounded Hypothesis terminal states", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:negative"],
    nodes: [{
      id: "hypothesis:invalid-status",
      graphKind: "reasoning",
      type: "Hypothesis",
      label: "Invalid negative state",
      properties: { status: "contradicted" },
      evidenceRefs: ["event:negative"]
    }],
    edges: []
  }), /invalid status "contradicted"/);

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:negative"],
    nodes: [{
      id: "hypothesis:missing-conclusion",
      graphKind: "reasoning",
      type: "Hypothesis",
      label: "Missing negative boundary",
      properties: { status: "refuted" },
      evidenceRefs: ["event:negative"]
    }],
    edges: []
  }), /non-empty negativeConclusion/);

  graphStore.close();
});

test("projection closure selects task-relevant negative knowledge from semantic anchors", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:negative"],
    nodes: [
      { id: "task:test", graphKind: "task", type: "Task", label: "Test session file inclusion", properties: {} },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      {
        id: "hypothesis:session-file",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Session file inclusion",
        properties: {
          status: "refuted",
          target: "/include",
          method: "session file candidates",
          preconditions: ["unauthenticated"],
          negativeConclusion: "tested candidates did not resolve",
          reopenConditions: "valid session id observed"
        },
        evidenceRefs: ["event:negative"]
      },
      {
        id: "evidence:session-file-negative",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Controlled session file probes matched baseline",
        properties: { target: "/include", observedResult: "same response oracle" },
        evidenceRefs: ["event:negative"]
      },
      {
        id: "hypothesis:unrelated",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Unrelated SQL injection",
        properties: { status: "open" }
      }
    ],
    edges: [{
      from: "evidence:session-file-negative",
      to: "hypothesis:session-file",
      type: "contradicts",
      evidenceRefs: ["event:negative"]
    }]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:test",
    scopeRef: "scope:root",
    anchors: ["Test session file inclusion at /include"],
    nodeLimit: 8,
    edgeLimit: 12
  });

  assert.ok(closure.nodes.some((node) => node.id === "hypothesis:session-file"));
  assert.ok(closure.nodes.some((node) => node.id === "evidence:session-file-negative"));
  assert.ok(closure.edges.some((edge) => edge.type === "contradicts"));
  assert.equal(closure.nodes.some((node) => node.id === "hypothesis:unrelated"), false);
  graphStore.close();
});

test("projection closure reserves topology-linked negative knowledge before text anchors", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  const unrelatedNodes = Array.from({ length: 8 }, (_, index) => ({
    id: `hypothesis:unrelated-${index}`,
    graphKind: "reasoning" as const,
    type: "Hypothesis",
    label: `Anchor noise ${index}`,
    properties: { status: "refuted", negativeConclusion: "unrelated negative result" },
    evidenceRefs: [`event:noise:${index}`]
  }));
  graphStore.upsertDelta({
    sourceEventIds: ["event:negative-topology"],
    nodes: [
      { id: "task:test", graphKind: "task", type: "Task", label: "Validate include endpoint", properties: {} },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      { id: "endpoint:include", graphKind: "operation", type: "WebEndpoint", label: "GET /include", properties: { path: "/include" } },
      {
        id: "hypothesis:session-file",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Session file inclusion",
        properties: { status: "refuted", negativeConclusion: "controlled candidates matched the baseline" },
        evidenceRefs: ["event:negative-topology"]
      },
      {
        id: "evidence:session-file-negative",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Session candidates matched the negative oracle",
        properties: { observedResult: "same response hash" },
        evidenceRefs: ["event:negative-topology"]
      },
      ...unrelatedNodes
    ],
    edges: [
      { from: "task:test", to: "endpoint:include", type: "requires_evidence" },
      { from: "hypothesis:session-file", to: "endpoint:include", type: "affects", evidenceRefs: ["event:negative-topology"] },
      {
        from: "evidence:session-file-negative",
        to: "hypothesis:session-file",
        type: "contradicts",
        evidenceRefs: ["event:negative-topology"]
      }
    ]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:test",
    scopeRef: "scope:root",
    targetRefs: ["endpoint:include"],
    anchors: ["Anchor noise"],
    nodeLimit: 8,
    edgeLimit: 12
  });
  const nodeIds = new Set(closure.nodes.map((node) => node.id));

  assert.ok(nodeIds.has("endpoint:include"));
  assert.ok(nodeIds.has("hypothesis:session-file"));
  assert.ok(nodeIds.has("evidence:session-file-negative"));
  assert.ok(closure.edges.some((edge) => edge.type === "contradicts"
    && edge.from === "evidence:session-file-negative"
    && edge.to === "hypothesis:session-file"));
  graphStore.close();
});

test("projection closure recovers dependency negatives by persisted evidence provenance", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:negative-provenance"],
    nodes: [
      {
        id: "task:predecessor",
        graphKind: "task",
        type: "Task",
        label: "Test prior privilege path",
        properties: { status: "partial", evidenceRefs: ["event:negative-provenance"] }
      },
      {
        id: "task:successor",
        graphKind: "task",
        type: "Task",
        label: "Continue privilege analysis",
        properties: { status: "open" }
      },
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Root goal", properties: {} },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      {
        id: "hypothesis:prior-path",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Prior privilege path",
        properties: { status: "refuted", negativeConclusion: "controlled attempt lacked the required capability" },
        evidenceRefs: ["event:negative-provenance"]
      },
      {
        id: "evidence:prior-path",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Prior privilege attempt result",
        properties: { observedResult: "operation denied under the observed capability set" },
        evidenceRefs: ["event:negative-provenance"]
      }
    ],
    edges: [{
      from: "evidence:prior-path",
      to: "hypothesis:prior-path",
      type: "contradicts",
      evidenceRefs: ["event:negative-provenance"]
    }]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:successor",
    scopeRef: "scope:root",
    dependencyTaskIds: ["task:predecessor"],
    targetRefs: ["goal:root", "scope:root"],
    anchors: ["unrelated wording with no semantic match"],
    nodeLimit: 8,
    edgeLimit: 12
  });
  const nodeIds = new Set(closure.nodes.map((node) => node.id));

  assert.ok(nodeIds.has("hypothesis:prior-path"));
  assert.ok(nodeIds.has("evidence:prior-path"));
  assert.ok(closure.edges.some((edge) => edge.type === "contradicts"
    && edge.from === "evidence:prior-path"
    && edge.to === "hypothesis:prior-path"));
  graphStore.close();
});

test("normalizes achieved root goal status to completed", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{ id: "goal:root", graphKind: "task", type: "Goal", label: "Get flag", properties: { status: "open" } }],
    edges: []
  });

  const goal = graphStore.setNodeStatus({ nodeId: "goal:root", status: "achieved" });

  assert.equal(goal.properties.status, "completed");
  graphStore.close();
});

test("projection graph merge and committed watermark update atomically", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:test", 9, 10, 9);
  const claim = runtimeStore.claimProjection("task:test");
  assert.ok(claim);

  graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:9"],
      nodes: [
        {
          id: "evidence:9",
          graphKind: "reasoning",
          type: "Evidence",
          label: "Projected evidence",
          properties: {},
          evidenceRefs: ["event:9"]
        },
        {
          id: "endpoint:9",
          graphKind: "operation",
          type: "WebEndpoint",
          label: "GET /projected",
          properties: { method: "GET", path: "/projected" },
          evidenceRefs: ["event:9"]
        }
      ],
      edges: [{ from: "evidence:9", to: "endpoint:9", type: "observed_on", evidenceRefs: ["event:9"] }]
    }
  });

  const projectionState = runtimeStore.getProjectionState("task:test");
  assert.equal(projectionState.committedSeq, 9);
  assert.equal(projectionState.terminalTargetSeq, 9);
  assert.equal(graphStore.query("reasoning", ["evidence:9"], 1).nodes[0]?.id, "evidence:9");
  runtimeStore.close();
  graphStore.close();
});

test("projection commit reports the persisted node status transition", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  graphStore.upsertDelta({
    sourceEventIds: ["event:open"],
    nodes: [
      {
        id: "hypothesis:path",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Path resolves through session storage",
        properties: { status: "open" },
        evidenceRefs: ["event:open"]
      },
      {
        id: "evidence:baseline",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Initial path behavior",
        properties: {},
        evidenceRefs: ["event:open"]
      }
    ],
    edges: [{ from: "evidence:baseline", to: "hypothesis:path", type: "supports", evidenceRefs: ["event:open"] }]
  });
  runtimeStore.raiseProjectionDesired("task:test", 2);
  const claim = runtimeStore.claimProjection("task:test");
  assert.ok(claim);

  const committed = graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:negative"],
      nodes: [{
        id: "hypothesis:path",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Path resolves through session storage",
        properties: {
          status: "refuted",
          negativeConclusion: "controlled candidates matched the negative baseline",
          reopenConditions: "valid session identifier observed"
        },
        evidenceRefs: ["event:negative"]
      }],
      edges: []
    }
  });

  assert.deepEqual(committed.nodeStatusChanges, [{
    nodeId: "hypothesis:path",
    label: "Path resolves through session storage",
    fromStatus: "open",
    toStatus: "refuted",
    evidenceRefs: ["event:negative"]
  }]);
  runtimeStore.close();
  graphStore.close();
});

test("graph upserts merge evidence references instead of replacing them", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:1"],
    nodes: [{
      id: "evidence:merge",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Merge evidence",
      properties: { first: true },
      evidenceRefs: ["event:1"]
    }],
    edges: []
  });
  graphStore.upsertDelta({
    sourceEventIds: ["event:2"],
    nodes: [{
      id: "evidence:merge",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Merge evidence",
      properties: { second: true },
      evidenceRefs: ["event:2"]
    }],
    edges: []
  });

  const node = graphStore.query("reasoning", ["evidence:merge"], 1).nodes[0];
  assert.deepEqual(node?.evidenceRefs, ["event:1", "event:2"]);
  assert.deepEqual(node?.properties, { first: true, second: true });
  graphStore.close();
});

test("rejects graph node type changes for an existing identity", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{ id: "task:read-flag", graphKind: "task", type: "Task", label: "Read flag", properties: {} }],
    edges: []
  });

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:1"],
    nodes: [{
      id: "task:read-flag",
      graphKind: "task",
      type: "Milestone",
      label: "Retyped task",
      properties: {},
      evidenceRefs: ["event:1"]
    }],
    edges: []
  }), /Reserved node id|Node identity conflict/);
  assert.equal(graphStore.query("task", ["task:read-flag"], 1).nodes[0]?.type, "Task");
  graphStore.close();
});

test("rejects graph node types stored in the wrong graph category", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:wrong-operation"],
    nodes: [{
      id: "evidence:wrong-operation",
      graphKind: "operation",
      type: "Evidence",
      label: "Evidence placed in operation graph",
      properties: {},
      evidenceRefs: ["event:wrong-operation"]
    }],
    edges: []
  }), /requires graphKind=reasoning/);

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:wrong-reasoning"],
    nodes: [{
      id: "blocker:wrong-reasoning",
      graphKind: "reasoning",
      type: "Blocker",
      label: "Blocker placed in reasoning graph",
      properties: {},
      evidenceRefs: ["event:wrong-reasoning"]
    }],
    edges: []
  }), /requires graphKind=task/);

  graphStore.close();
});

test("projection closure prioritizes semantic memory linked to the current task", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:memory"],
    nodes: [
      { id: "task:test", graphKind: "task", type: "Task", label: "Test", properties: {} },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      { id: "evidence:memory", graphKind: "reasoning", type: "Evidence", label: "passwd read", properties: {}, evidenceRefs: ["event:memory"] },
      { id: "vuln:path-traversal", graphKind: "reasoning", type: "Vulnerability", label: "Path traversal", properties: {}, evidenceRefs: ["event:memory"] },
      { id: "endpoint:download", graphKind: "operation", type: "WebEndpoint", label: "GET /download.php", properties: { path: "/download.php" } }
    ],
    edges: [
      { from: "task:test", to: "scope:root", type: "within_scope" },
      { from: "task:test", to: "evidence:memory", type: "produces_evidence", evidenceRefs: ["event:memory"] },
      { from: "evidence:memory", to: "vuln:path-traversal", type: "confirms", evidenceRefs: ["event:memory"] },
      { from: "vuln:path-traversal", to: "endpoint:download", type: "affects", evidenceRefs: ["event:memory"] }
    ]
  });

  const closure = graphStore.projectionClosure({
    taskId: "task:test",
    scopeRef: "scope:root",
    anchors: [],
    nodeLimit: 8,
    edgeLimit: 12
  });
  const nodeIds = new Set(closure.nodes.map((node) => node.id));
  assert.ok(nodeIds.has("evidence:memory"));
  assert.ok(nodeIds.has("vuln:path-traversal"));
  assert.ok(nodeIds.has("endpoint:download"));
  graphStore.close();
});

test("projection commit conflict rolls back graph writes and watermark", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:rollback", 4);
  const claim = runtimeStore.claimProjection("task:rollback");
  assert.ok(claim);

  assert.throws(() => graphStore.commitProjection({
    ...claim,
    generation: claim.generation + 1,
    delta: {
      sourceEventIds: ["event:4"],
      nodes: [{
        id: "evidence:must-not-exist",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Must roll back",
        properties: {},
        evidenceRefs: ["event:4"]
      }],
      edges: []
    }
  }), /generation conflict/);

  assert.equal(runtimeStore.getProjectionState("task:rollback").committedSeq, 0);
  assert.equal(graphStore.query("reasoning", ["evidence:must-not-exist"], 1).nodes.length, 0);
  runtimeStore.close();
  graphStore.close();
});

test("projection commits merge concurrent operation identities without losing topology", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:8001", 83);
  runtimeStore.raiseProjectionDesired("task:8000", 115);
  const claim8001 = runtimeStore.claimProjection("task:8001");
  const claim8000 = runtimeStore.claimProjection("task:8000");
  assert.ok(claim8001);
  assert.ok(claim8000);

  const first = graphStore.commitProjection({
    ...claim8001,
    delta: {
      sourceEventIds: ["event:8001"],
      nodes: [
        { id: "projected:host-a", graphKind: "operation", type: "Host", label: "60.205.226.234", properties: { first: true }, evidenceRefs: ["event:8001"] },
        { id: "projected:port-8001", graphKind: "operation", type: "Port", label: "8001/TCP", properties: {}, evidenceRefs: ["event:8001"] }
      ],
      edges: [{ from: "projected:host-a", to: "projected:port-8001", type: "has_port", evidenceRefs: ["event:8001"] }]
    }
  });
  const second = graphStore.commitProjection({
    ...claim8000,
    delta: {
      sourceEventIds: ["event:8000"],
      nodes: [
        { id: "projected:host-b", graphKind: "operation", type: "Host", label: "60.205.226.234", properties: { second: true }, evidenceRefs: ["event:8000"] },
        { id: "projected:port-8000", graphKind: "operation", type: "Port", label: "8000/TCP", properties: { port: 8000, protocol: "tcp" }, evidenceRefs: ["event:8000"] }
      ],
      edges: [{ from: "projected:host-b", to: "projected:port-8000", type: "has_port", evidenceRefs: ["event:8000"] }]
    }
  });

  const operation = graphStore.query("operation", [], 20);
  const hosts = operation.nodes.filter((node) => node.type === "Host");
  const ports = operation.nodes.filter((node) => node.type === "Port");
  assert.equal(hosts.length, 1);
  assert.deepEqual(hosts[0]?.properties, { first: true, second: true });
  assert.deepEqual(hosts[0]?.evidenceRefs, ["event:8001", "event:8000"]);
  assert.deepEqual(new Set(ports.map((node) => node.label)), new Set(["8000/TCP", "8001/TCP"]));
  assert.equal(operation.edges.filter((edge) => edge.from === hosts[0]?.id && edge.type === "has_port").length, 2);
  assert.ok(first.remappedNodeCount >= 2);
  assert.ok(second.remappedNodeCount >= 2);
  assert.equal(runtimeStore.getProjectionState("task:8001").committedSeq, 83);
  assert.equal(runtimeStore.getProjectionState("task:8000").committedSeq, 115);
  runtimeStore.close();
  graphStore.close();
});

test("projection identity rebasing reuses operation identities incrementally indexed by ordinary deltas", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  graphStore.upsertDelta({
    sourceEventIds: ["event:legacy"],
    nodes: [{
      id: "legacy:host",
      graphKind: "operation",
      type: "Host",
      label: "192.0.2.44",
      properties: { source: "legacy" }
    }],
    edges: []
  });
  runtimeStore.raiseProjectionDesired("task:incremental-identity", 2);
  const claim = runtimeStore.claimProjection("task:incremental-identity");
  assert.ok(claim);

  const committed = graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:new"],
      nodes: [{
        id: "projected:duplicate-host",
        graphKind: "operation",
        type: "Host",
        label: "192.0.2.44",
        properties: { source: "projection" }
      }],
      edges: []
    }
  });

  assert.equal(committed.delta.nodes[0]?.id, "legacy:host");
  assert.equal(graphStore.query("operation", [], 10).nodes.filter((node) => node.type === "Host").length, 1);
  runtimeStore.close();
  graphStore.close();
});

test("projection commit rejects dangling edges and preserves the watermark", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:dangling", 9);
  const claim = runtimeStore.claimProjection("task:dangling");
  assert.ok(claim);

  assert.throws(() => graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:9"],
      nodes: [{ id: "projected:evidence", graphKind: "reasoning", type: "Evidence", label: "Evidence", properties: {}, evidenceRefs: ["event:9"] }],
      edges: [{ from: "projected:evidence", to: "projected:missing", type: "observed_on", evidenceRefs: ["event:9"] }]
    }
  }), /references missing node/);
  assert.equal(runtimeStore.getProjectionState("task:dangling").committedSeq, 0);
  assert.equal(graphStore.query("reasoning", ["projected:evidence"], 1).nodes.length, 0);
  runtimeStore.close();
  graphStore.close();
});

test("graph writes reject dangling edges outside projection commits", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: ["event:dangling"],
    nodes: [{ id: "evidence:real", graphKind: "reasoning", type: "Evidence", label: "Evidence", properties: {} }],
    edges: [{ from: "evidence:real", to: "host:missing", type: "observed_on" }]
  }), /references missing node/);
  assert.equal(graphStore.query("reasoning", ["evidence:real"], 1).nodes.length, 0);
  graphStore.close();
});

test("raw task targets stay in task properties without creating placeholder edges", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:root"],
    nodes: [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: { status: "open" } },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} }
    ],
    edges: []
  });

  graphStore.createTasks([{
    taskId: "task:raw-target",
    goal: "Inspect one endpoint",
    targetRefs: ["192.0.2.10:8080"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["Observe HTTP response"],
    parentTaskId: "goal:root",
    priority: 1
  }]);

  assert.deepEqual(graphStore.getTaskNode("task:raw-target")?.properties.targetRefs, ["192.0.2.10:8080"]);
  assert.equal(
    graphStore.query("task", ["task:raw-target"], 2).edges.some((edge) => edge.type === "requires_evidence"),
    false
  );
  graphStore.close();
});

test("opening a legacy graph removes previously persisted dangling edges", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const deltaLogPath = join(runtimeDir, "deltas.jsonl");
  const graphStore = new SQLiteGraphStore(databasePath, deltaLogPath);
  graphStore.upsertDelta({
    sourceEventIds: ["event:legacy"],
    nodes: [{ id: "evidence:legacy", graphKind: "reasoning", type: "Evidence", label: "Legacy", properties: {} }],
    edges: []
  });
  graphStore.close();

  const database = new DatabaseSync(databasePath);
  database.prepare(`
    INSERT INTO edges (id, from_id, to_id, type, properties_json, evidence_refs_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "edge:legacy-dangling",
    "evidence:legacy",
    "host:missing",
    "observed_on",
    "{}",
    "[]",
    new Date().toISOString()
  );
  database.close();

  const reopened = new SQLiteGraphStore(databasePath, deltaLogPath);
  assert.equal(reopened.query("reasoning", ["evidence:legacy"], 2).edges.length, 0);
  reopened.close();
});

test("opening a graph removes the retired projection repair state", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const deltaLogPath = join(runtimeDir, "deltas.jsonl");
  let graphStore = new SQLiteGraphStore(databasePath, deltaLogPath);
  graphStore.upsertDelta({
    sourceEventIds: ["event:legacy-unresolved"],
    nodes: [{
      id: "evidence:legacy-unresolved",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Legacy unresolved evidence",
      properties: { unresolved: true, unresolvedTaskRef: "task:legacy" },
      evidenceRefs: ["event:legacy-unresolved"]
    }],
    edges: []
  });
  graphStore.close();
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE projection_unresolved_nodes (node_id TEXT PRIMARY KEY)");
  database.close();

  graphStore = new SQLiteGraphStore(databasePath, deltaLogPath);
  const restored = graphStore.query("reasoning", ["evidence:legacy-unresolved"], 1).nodes[0];
  assert.equal(restored?.properties.unresolved, undefined);
  assert.equal(restored?.properties.unresolvedTaskRef, undefined);
  graphStore.close();

  const verified = new DatabaseSync(databasePath);
  assert.equal(verified.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_unresolved_nodes'"
  ).get(), undefined);
  verified.close();
});

test("projection rejects unconnected semantic nodes atomically", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:unconnected", 3);
  const claim = runtimeStore.claimProjection("task:unconnected");
  assert.ok(claim);

  assert.throws(() => graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:3"],
      nodes: [{
        id: "projected:unconnected",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Unconnected evidence",
        properties: {},
        evidenceRefs: ["event:3"]
      }],
      edges: []
    }
  }), /cannot commit unconnected semantic nodes: projected:unconnected/);

  assert.equal(runtimeStore.getProjectionState("task:unconnected").committedSeq, 0);
  assert.equal(graphStore.query("reasoning", ["projected:unconnected"], 1).nodes.length, 0);
  runtimeStore.close();
  graphStore.close();
});
test("projection does not merge semantic nodes by label", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  runtimeStore.raiseProjectionDesired("task:semantic-identity", 1);
  const claim = runtimeStore.claimProjection("task:semantic-identity");
  assert.ok(claim);
  const result = graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: ["event:semantic"],
      nodes: [
        {
          id: "vulnerability:first",
          graphKind: "reasoning",
          type: "Vulnerability",
          label: "Token exchange bypass",
          properties: { variant: "first" },
          evidenceRefs: ["event:semantic"]
        },
        {
          id: "vulnerability:second",
          graphKind: "reasoning",
          type: "Vulnerability",
          label: "Token exchange bypass",
          properties: { variant: "second" },
          evidenceRefs: ["event:semantic"]
        },
        {
          id: "endpoint:semantic-target",
          graphKind: "operation",
          type: "WebEndpoint",
          label: "POST /token/exchange",
          properties: { method: "POST", path: "/token/exchange" },
          evidenceRefs: ["event:semantic"]
        }
      ],
      edges: [
        { from: "vulnerability:first", to: "endpoint:semantic-target", type: "affects", evidenceRefs: ["event:semantic"] },
        { from: "vulnerability:second", to: "endpoint:semantic-target", type: "affects", evidenceRefs: ["event:semantic"] }
      ]
    }
  });
  assert.equal(result.remappedNodeCount, 0);
  assert.equal(result.mergedNodeCount, 0);
  assert.deepEqual(
    new Set(graphStore.query("reasoning", ["vulnerability:first", "vulnerability:second"], 4).nodes.map((node) => node.id)),
    new Set(["vulnerability:first", "vulnerability:second"])
  );
  runtimeStore.close();
  graphStore.close();
});

test("rejects confirmed vulnerability without evidence refs", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  assert.throws(() => {
    graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [
        {
          id: "vuln:sqli",
          graphKind: "reasoning",
          type: "Vulnerability",
          label: "SQL injection",
          properties: {}
        }
      ],
      edges: []
    });
  }, GraphValidationError);
  graphStore.close();
});

test("lists open task definitions without inferring dependency outcomes from graph status", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTask({
    taskId: "task:recon-a",
    goal: "Recon A",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["A done"],
    priority: 1,
    parentTaskId: "goal:root",
    parallelGroup: "recon"
  });
  graphStore.createTask({
    taskId: "task:recon-b",
    goal: "Recon B",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["B done"],
    priority: 1,
    parentTaskId: "goal:root",
    parallelGroup: "recon"
  });
  graphStore.createTask({
    taskId: "task:exploit",
    goal: "Exploit after recon",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["flag found"],
    priority: 2,
    parentTaskId: "goal:root",
    dependsOnTaskRefs: ["task:recon-a", "task:recon-b"]
  });

  assert.deepEqual(
    graphStore.listOpenTasks(10).map((task) => task.taskId),
    ["task:recon-a", "task:recon-b", "task:exploit"]
  );

  graphStore.markTaskStatus({ taskId: "task:recon-a", status: "partial" });
  assert.deepEqual(
    graphStore.listOpenTasks(10).map((task) => task.taskId),
    ["task:recon-b", "task:exploit"]
  );

  graphStore.markTaskStatus({ taskId: "task:recon-b", status: "completed" });
  assert.deepEqual(
    graphStore.listOpenTasks(10).map((task) => task.taskId),
    ["task:exploit"]
  );
  graphStore.close();
});

test("task envelopes replace legacy Planner constraints with the authoritative Scope summary", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "scope:root",
      graphKind: "task",
      type: "Scope",
      label: "Authorized scope",
      properties: { summary: "仅允许测试 10.0.0.8；禁止破坏性操作" }
    }],
    edges: []
  });
  graphStore.createTasks([{
    taskId: "task:legacy-constraints",
    goal: "Resolve one uncertainty",
    targetRefs: [],
    scopeRef: "scope:root",
    constraints: ["PHP:// uppercase is confirmed", "Use this exact payload"],
    successCriteria: ["Record an observable result"],
    priority: 1
  }]);

  assert.deepEqual(graphStore.getTaskEnvelope("task:legacy-constraints")?.constraints, [
    "授权范围原文：仅允许测试 10.0.0.8；禁止破坏性操作"
  ]);
  assert.deepEqual(graphStore.listOpenTasks(10)[0]?.constraints, [
    "授权范围原文：仅允许测试 10.0.0.8；禁止破坏性操作"
  ]);
  graphStore.close();
});

test("planner task ledger preserves dependency structure without deriving runtime readiness", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:partial-dependency",
      goal: "Produce a reusable partial outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["partial evidence"],
      priority: 1
    },
    {
      taskId: "task:failed-dependency",
      goal: "Fail without a reusable outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["failure"],
      priority: 2
    },
    {
      taskId: "task:ready-child",
      goal: "Consume the partial outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["consume outcome"],
      dependsOnTaskRefs: ["task:partial-dependency"],
      priority: 3
    },
    {
      taskId: "task:blocked-child",
      goal: "Must remain blocked after dependency failure",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["must not run"],
      dependsOnTaskRefs: ["task:failed-dependency"],
      priority: 4
    }
  ]);
  graphStore.markTaskStatus({ taskId: "task:partial-dependency", status: "partial" });
  graphStore.markTaskStatus({ taskId: "task:failed-dependency", status: "failed" });

  const ledger = new Map(graphStore.plannerDecisionView().taskLedger.map((item) => [item.taskId, item]));
  assert.equal(ledger.get("task:ready-child")?.ready, undefined);
  assert.equal(ledger.get("task:ready-child")?.blockedByTaskRefs, undefined);
  assert.equal(ledger.get("task:ready-child")?.dependencyStatuses, undefined);
  assert.deepEqual(ledger.get("task:ready-child")?.dependsOnTaskRefs, ["task:partial-dependency"]);
  assert.deepEqual(ledger.get("task:blocked-child")?.dependsOnTaskRefs, ["task:failed-dependency"]);
  assert.deepEqual(
    graphStore.listOpenTasks(10).map((task) => task.taskId),
    ["task:ready-child", "task:blocked-child"]
  );
  graphStore.close();
});

test("planner dependency preflight reports the exact cycle without mutating the graph", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:entry",
      goal: "Entry reconnaissance",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["understand entry surface"],
      priority: 1
    },
    {
      taskId: "task:auth",
      goal: "Authenticate",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["obtain session"],
      priority: 2,
      dependsOnTaskRefs: ["task:entry"]
    },
    {
      taskId: "task:discovery",
      goal: "Discover authenticated resources",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["map resources"],
      priority: 3,
      dependsOnTaskRefs: ["task:auth"]
    }
  ]);

  assert.throws(
    () => graphStore.validatePlannerDecision({
      decision: "apply_commands",
      commands: [{
        kind: "replace_dependencies",
        taskId: "task:auth",
        dependencyTaskIds: ["task:entry", "task:discovery"]
      }],
      reason: "invalidly reverse the dependency direction",
      basedOnRefs: ["task:discovery"]
    }),
    /Dependency graph would contain a cycle: task:auth -> task:discovery -> task:auth/
  );
  assert.deepEqual(graphStore.getTaskEnvelope("task:auth")?.dependsOnTaskRefs, ["task:entry"]);
  graphStore.close();
});

test("archived dependency summaries do not alter structural open-task listing", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:archived-with-result",
      goal: "Preserve a prior outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["produce a reusable outcome"],
      priority: 1
    },
    {
      taskId: "task:child-with-result",
      goal: "Consume the prior outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["reuse the outcome"],
      priority: 2,
      dependsOnTaskRefs: ["task:archived-with-result"]
    },
    {
      taskId: "task:archived-without-result",
      goal: "Never executed stale task",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["none"],
      priority: 3
    },
    {
      taskId: "task:child-without-result",
      goal: "Must not run without an outcome",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["wait"],
      priority: 4,
      dependsOnTaskRefs: ["task:archived-without-result"]
    }
  ]);
  graphStore.markTaskStatus({
    taskId: "task:archived-with-result",
    status: "archived",
    properties: { resultSummary: "Reusable authenticated session discovered" }
  });
  graphStore.markTaskStatus({ taskId: "task:archived-without-result", status: "archived" });

  assert.deepEqual(
    graphStore.listOpenTasks(10).map((task) => task.taskId),
    ["task:child-with-result", "task:child-without-result"]
  );
  graphStore.close();
});

test("rejects scheduler dependency edges outside Task to Task", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTask({
    taskId: "task:recon",
    goal: "Recon target",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["recon complete"],
    priority: 1
  });
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "host:target",
      graphKind: "operation",
      type: "Host",
      label: "target",
      properties: {}
    }],
    edges: []
  });

  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [],
    edges: [{ from: "task:recon", to: "host:target", type: "depends_on" }]
  }), GraphValidationError);
  graphStore.close();
});

test("archived tasks remain auditable but are excluded from open task definitions", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTask({
    taskId: "task:obsolete",
    goal: "Obsolete overlapping exploration",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["obsolete"],
    priority: 1
  });

  graphStore.setTaskStatus({
    taskId: "task:obsolete",
    status: "archived",
    reason: "Superseded by a confirmed capability"
  });

  assert.deepEqual(graphStore.listOpenTasks(10), []);
  const archived = graphStore.getTaskNode("task:obsolete");
  assert.equal(archived?.properties.status, "archived");
  assert.equal(archived?.properties.plannerReason, "Superseded by a confirmed capability");
  graphStore.close();
});

test("replaces task dependencies through edges only", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:recon-a",
      goal: "Recon A",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["A done"],
      priority: 1
    },
    {
      taskId: "task:recon-b",
      goal: "Recon B",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["B done"],
      priority: 1
    },
    {
      taskId: "task:exploit",
      goal: "Exploit after recon",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["flag found"],
      priority: 2,
      dependsOnTaskRefs: ["task:recon-a"]
    }
  ]);

  graphStore.replaceTaskDependencies({
    taskId: "task:exploit",
    dependencyTaskIds: ["task:recon-b"]
  });
  graphStore.markTaskStatus({ taskId: "task:recon-a", status: "completed" });

  assert.deepEqual(
    graphStore.getTaskEnvelope("task:exploit")?.dependsOnTaskRefs,
    ["task:recon-b"]
  );
  assert.equal(graphStore.listOpenTasks(10).some((task) => task.taskId === "task:exploit"), true);

  graphStore.markTaskStatus({ taskId: "task:recon-b", status: "completed" });
  assert.equal(graphStore.listOpenTasks(10).some((task) => task.taskId === "task:exploit"), true);
  graphStore.close();
});

test("runtime task result preserves planner version for later expectedVersion patches", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([
    {
      taskId: "task:recon",
      goal: "Recon target",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["recon done"],
      priority: 1
    },
    {
      taskId: "task:extract-flag",
      goal: "Extract flag",
      targetRefs: ["goal:root"],
      basisRefs: ["evidence:auth-bypass", "artifact:reusable-poc"],
      scopeRef: "scope:root",
      constraints: ["scope"],
      successCriteria: ["flag found"],
      priority: 2,
      dependsOnTaskRefs: ["task:recon"],
      budget: { maxTurns: 12 }
    }
  ]);

  const patched = graphStore.patchTask({
    taskId: "task:extract-flag",
    expectedVersion: 1,
    patch: {
      budget: { maxTurns: 24 }
    }
  });
  assert.equal(patched.properties.version, 2);

  const taskEnvelope = graphStore.getTaskEnvelope("task:extract-flag");
  assert.ok(taskEnvelope);
  assert.deepEqual(taskEnvelope.basisRefs, ["evidence:auth-bypass", "artifact:reusable-poc"]);
  graphStore.markTaskStatus({
    taskId: "task:extract-flag",
    status: "running",
    properties: { startedAt: "2026-07-10T00:00:00.000Z" }
  });
  assert.equal(graphStore.getTaskNode("task:extract-flag")?.properties.version, 2);

  graphStore.updateTaskResult({
    taskEnvelope,
    taskResult: {
      taskId: "task:extract-flag",
      status: "partial",
      summary: "Checkpointed after auth bypass attempts",
      evidenceRefs: ["event:auth"],
      artifactRefs: ["artifact:auth"],
      checkpointReason: "timeout",
      retryable: true,
      resumeCursor: "event:last"
    },
    sourceEventIds: ["event:partial"]
  });
  const afterRuntime = graphStore.getTaskNode("task:extract-flag");
  assert.equal(afterRuntime?.properties.version, 2);
  assert.equal(afterRuntime?.properties.runtimeVersion, 1);
  assert.equal(afterRuntime?.properties.status, "running");
  assert.equal(afterRuntime?.properties.lastOutcomeRef, undefined);
  assert.equal(afterRuntime?.properties.resultSummary, undefined);
  assert.deepEqual(graphStore.getTaskEnvelope("task:extract-flag")?.basisRefs,
    ["evidence:auth-bypass", "artifact:reusable-poc"]);
  assert.deepEqual(graphStore.getTaskEnvelope("task:extract-flag")?.dependsOnTaskRefs, ["task:recon"]);

  const nextPatch = graphStore.patchTask({
    taskId: "task:extract-flag",
    expectedVersion: 2,
    patch: { priority: 1 }
  });
  assert.equal(nextPatch.properties.version, 3);
  assert.equal(nextPatch.label, "Extract flag");
  graphStore.close();
});

test("planner task command batch uses one snapshot version per task", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.createTasks([{
    taskId: "task:recon-web",
    goal: "Recon web",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["find ssrf"],
    priority: 1,
    budget: { maxTurns: 10 }
  }]);
  graphStore.markTaskStatus({
    taskId: "task:recon-web",
    status: "partial",
    properties: { checkpointReason: "maxTurns" }
  });

  const results = graphStore.applyTaskCommandBatch([
    {
      commandIndex: 0,
      kind: "set_task_status",
      taskId: "task:recon-web",
      status: "open",
      expectedVersion: 1,
      sourceEventIds: ["event:planner"],
      reason: "resume recon"
    },
    {
      commandIndex: 1,
      kind: "patch_task",
      taskId: "task:recon-web",
      patch: { budget: { maxTurns: 16 } },
      expectedVersion: 1,
      sourceEventIds: ["event:planner"],
      reason: "extend budget"
    }
  ]);

  const task = graphStore.getTaskNode("task:recon-web");
  assert.equal(task?.properties.status, "open");
  assert.deepEqual(task?.properties.budget, { maxTurns: 16 });
  assert.equal(task?.properties.version, 2);
  assert.equal(task?.properties.plannerReason, "resume recon；extend budget");
  assert.deepEqual(results.map((result) => result.node.properties.version), [2, 2]);
  assert.doesNotThrow(() => graphStore.patchTask({
    taskId: "task:recon-web",
    expectedVersion: 2,
    patch: { priority: 2 }
  }));
  graphStore.close();
});

test("planner decision applies all graph mutations atomically", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "goal:root",
      graphKind: "task",
      type: "Goal",
      label: "Root goal",
      properties: { status: "open", version: 1 }
    }],
    edges: []
  });
  graphStore.createTasks([{
    taskId: "task:existing",
    goal: "Existing task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["done"],
    priority: 1
  }]);
  graphStore.patchTask({ taskId: "task:existing", expectedVersion: 1, patch: { priority: 2 } });

  assert.throws(() => graphStore.applyPlannerDecision({
    createTasks: [{
      taskId: "task:must-rollback",
      goal: "Must not survive conflict",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["never committed"],
      priority: 1
    }],
    taskCommands: [{
      commandIndex: 1,
      kind: "patch_task",
      taskId: "task:existing",
      patch: { priority: 3 },
      expectedVersion: 1,
      sourceEventIds: ["event:planner"]
    }],
    nodeStatusCommands: [],
    sourceEventIds: ["event:planner"]
  }), (error) => {
    assert.ok(error instanceof PlannerDecisionConflict);
    assert.equal(error.conflicts[0]?.nodeId, "task:existing");
    assert.equal(error.conflicts[0]?.expectedVersion, 1);
    assert.equal(error.conflicts[0]?.currentVersion, 2);
    return true;
  });
  assert.equal(graphStore.getTaskNode("task:must-rollback"), undefined);
  assert.equal(graphStore.getTaskNode("task:existing")?.label, "Existing task");

  graphStore.applyPlannerDecision({
    createTasks: [{
      taskId: "task:created",
      goal: "Created atomically",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["created"],
      priority: 1
    }],
    taskCommands: [{
      commandIndex: 1,
      kind: "set_task_status",
      taskId: "task:existing",
      status: "completed",
      expectedVersion: 2,
      sourceEventIds: ["event:planner"],
      reason: "complete existing"
    }],
    nodeStatusCommands: [{
      commandIndex: 2,
      nodeId: "goal:root",
      status: "completed",
      expectedVersion: 1,
      sourceEventIds: ["event:planner"],
      reason: "complete root"
    }],
    sourceEventIds: ["event:planner"]
  });

  assert.equal(graphStore.getTaskNode("task:created")?.properties.version, 1);
  assert.equal(graphStore.getTaskNode("task:existing")?.properties.status, "completed");
  assert.equal(graphStore.query("task", ["goal:root"], 1).nodes[0]?.properties.status, "completed");
  graphStore.close();
});

test("set_node_status rejects Task targets while preserving non-Task status updates", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Root", properties: { status: "open", version: 1 } },
      { id: "milestone:foothold", graphKind: "task", type: "Milestone", label: "Foothold", properties: { status: "open", version: 1 } },
      { id: "blocker:route", graphKind: "task", type: "Blocker", label: "Route", properties: { status: "open", version: 1 } }
    ],
    edges: []
  });
  graphStore.createTasks([{
    taskId: "task:existing",
    goal: "Existing Task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["done"],
    priority: 1
  }]);

  assert.throws(() => graphStore.validatePlannerDecision({
    decision: "apply_commands",
    commands: [{ kind: "set_node_status", nodeId: "task:existing", status: "open", basedOnRefs: [] }],
    reason: "bypass Task status command"
  }), /Task task:existing status must be changed with set_task_status/);
  assert.throws(() => graphStore.setNodeStatus({
    nodeId: "task:existing",
    status: "archived"
  }), /Task task:existing status must be changed with set_task_status/);
  assert.throws(() => graphStore.applyPlannerDecision({
    createTasks: [],
    taskCommands: [],
    nodeStatusCommands: [{
      commandIndex: 0,
      nodeId: "task:existing",
      status: "archived",
      expectedVersion: 1,
      sourceEventIds: ["event:planner"]
    }],
    sourceEventIds: ["event:planner"]
  }), /Task task:existing status must be changed with set_task_status/);
  assert.equal(graphStore.getTaskNode("task:existing")?.properties.status, "open");

  assert.throws(() => graphStore.validatePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:new",
        goal: "New Task",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        successCriteria: ["done"],
        priority: 1
      }],
      basedOnRefs: []
    }, {
      kind: "set_node_status",
      nodeId: "task:new",
      status: "completed",
      basedOnRefs: []
    }],
    reason: "attempt to bypass a same-decision Task status"
  }), /Task task:new status must be changed with set_task_status/);
  assert.throws(() => graphStore.applyPlannerDecision({
    createTasks: [{
      taskId: "task:new",
      goal: "New Task",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["done"],
      priority: 1
    }],
    taskCommands: [],
    nodeStatusCommands: [{
      commandIndex: 1,
      nodeId: "task:new",
      status: "completed",
      sourceEventIds: ["event:planner"]
    }],
    sourceEventIds: ["event:planner"]
  }), /Task task:new status must be changed with set_task_status/);
  assert.equal(graphStore.getTaskNode("task:new"), undefined);

  graphStore.applyPlannerDecision({
    createTasks: [],
    taskCommands: [],
    nodeStatusCommands: [
      { commandIndex: 0, nodeId: "goal:root", status: "achieved", expectedVersion: 1, sourceEventIds: [] },
      { commandIndex: 1, nodeId: "milestone:foothold", status: "completed", expectedVersion: 1, sourceEventIds: [] },
      { commandIndex: 2, nodeId: "blocker:route", status: "resolved", expectedVersion: 1, sourceEventIds: [] }
    ],
    sourceEventIds: []
  });
  assert.equal(graphStore.query("task", ["goal:root"], 1).nodes[0]?.properties.status, "completed");
  assert.equal(graphStore.query("task", ["milestone:foothold"], 1).nodes[0]?.properties.status, "completed");
  assert.equal(graphStore.query("task", ["blocker:route"], 1).nodes[0]?.properties.status, "resolved");
  graphStore.close();
});

test("builds compact planner decision view without copying TaskOutcome fields into Task definitions", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:task", "event:flag"],
    nodes: [
      {
        id: "task:read-flag",
        graphKind: "task",
        type: "Task",
        label: "Read the known flag path",
        properties: {
          status: "partial",
          resultSummary: "Web shell works; /challenge/flag.txt still needs reading",
          checkpointReason: "handoff to planner",
          resumeCursor: "event:tool:3",
          targetRefs: ["endpoint:/c.php"],
          scopeRef: "scope:root",
          priority: 1,
          artifactRefs: ["artifact:large-stdout"]
        }
      },
      {
        id: "evidence:flag-path",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Flag path likely /challenge/flag.txt",
        properties: {
          status: "observed",
          rawBody: "x".repeat(5000),
          artifactRefs: ["artifact:raw-page"]
        },
        evidenceRefs: ["event:flag"]
      },
      {
        id: "vuln:webshell",
        graphKind: "reasoning",
        type: "Vulnerability",
        label: "Writable web shell confirmed",
        properties: { status: "confirmed", severity: "high" },
        evidenceRefs: ["event:webshell"]
      },
      {
        id: "endpoint:/c.php",
        graphKind: "operation",
        type: "WebEndpoint",
        label: "GET /c.php",
        properties: { status: "alive", method: "GET", path: "/c.php", rawBody: "hidden raw" }
      },
      {
        id: "session:admin",
        graphKind: "operation",
        type: "Session",
        label: "Admin session",
        properties: { status: "valid", role: "admin", token: "secret-token" }
      }
    ],
    edges: [
      { from: "task:read-flag", to: "endpoint:/c.php", type: "requires_evidence" },
      { from: "evidence:flag-path", to: "vuln:webshell", type: "supports", evidenceRefs: ["event:flag"] }
    ]
  });

  const view = graphStore.plannerDecisionView();
  assert.equal(view.view, "planner_decision");
  assert.equal(view.taskLedger[0]?.taskId, "task:read-flag");
  assert.deepEqual(view.taskLedger[0], {
    taskId: "task:read-flag",
    status: "partial",
    goal: "Read the known flag path",
    priority: 1,
    dependsOnTaskRefs: []
  });
  assert.ok(view.reasoningDigest.some((item) => item.id === "vuln:webshell" && item.reasons.includes("important_state:confirmed")));
  assert.ok(view.reasoningDigest.some((item) => item.id === "evidence:flag-path" && item.reasons.includes("decision_keyword")));
  assert.ok(view.operationDigest.some((item) => item.id === "session:admin" && item.reasons.includes("important_state:valid")));
  assert.ok(view.operationDigest.some((item) => item.id === "endpoint:/c.php"));
  assert.equal(view.reasoningDigest.find((item) => item.id === "evidence:flag-path")?.properties.rawBody, undefined);
  assert.equal(view.operationDigest.find((item) => item.id === "session:admin")?.properties.token, undefined);
  assert.deepEqual(view.retrievalHints.tools, ["graph_query", "graph_trace", "evidence_list", "evidence_read", "artifact_read"]);
  graphStore.close();
});

test("planner task ledger excludes legacy runtime outcome fields", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "task:long-result",
      graphKind: "task",
      type: "Task",
      label: "Long result task",
      properties: { status: "partial", resultSummary: `.agent-runtime ${"x".repeat(5_000)}` }
    }],
    edges: []
  });

  assert.deepEqual(graphStore.plannerDecisionView().taskLedger[0], {
    taskId: "task:long-result",
    status: "partial",
    goal: "Long result task",
    priority: undefined,
    dependsOnTaskRefs: []
  });
  graphStore.close();
});

test("planner decision view does not discard reasoning conclusions behind a top-ten ranking", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: ["event:reasoning"],
    nodes: Array.from({ length: 14 }, (_, index) => ({
      id: `hypothesis:${index}`,
      graphKind: "reasoning" as const,
      type: "Hypothesis",
      label: `Branch ${index}`,
      properties: index === 13
        ? { status: "refuted", negativeConclusion: "controlled test refuted this branch" }
        : { status: "open" },
      evidenceRefs: [`event:${index}`]
    })),
    edges: []
  });

  const view = graphStore.plannerDecisionView();
  assert.equal(view.reasoningDigest.length, 14);
  assert.ok(view.reasoningDigest.some((item) => item.id === "hypothesis:13" && item.status === "refuted"));
  graphStore.close();
});

test("planner decision view exposes the stored Root Goal and Scope references", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: {} },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} }
    ],
    edges: [{ from: "goal:root", to: "scope:root", type: "within_scope" }]
  });

  assert.deepEqual(graphStore.plannerDecisionView().rootRefs, {
    goalRef: "goal:root",
    scopeRef: "scope:root"
  });
  graphStore.close();
});

test("canonically identifies parallel operational edges after endpoint resolution", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} },
      { id: "host:c", graphKind: "operation", type: "Host", label: "C", properties: {} },
      { id: "agent-session:1", graphKind: "operation", type: "AgentSession", label: "Agent", properties: { status: "live", sessionId: "1" } },
      { id: "shell-session:1", graphKind: "operation", type: "ShellSession", label: "Shell", properties: { status: "degraded", sessionId: "1" } }
    ],
    edges: [
      { id: "tunnel:1", from: "host:a", to: "host:b", type: "tunnels_to", properties: { tunnelId: "1", status: "live" } },
      { id: "tunnel:2", from: "host:a", to: "host:b", type: "tunnels_to", properties: { tunnelId: "2", status: "degraded" } },
      { from: "host:a", to: "host:b", type: "proxy_route", properties: { via: "first" } },
      { from: "host:a", to: "host:c", type: "proxy_route", properties: { routeId: "route:shared", via: "second" } },
      { from: "agent-session:1", to: "host:a", type: "session_on" }
    ]
  });
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [],
    edges: [{ from: "host:a", to: "host:b", type: "proxy_route", properties: { transport: "socks" } }]
  });

  const operation = graphStore.query("operation", [], 100);
  assert.deepEqual(operation.edges.filter((edge) => edge.type === "tunnels_to").map((edge) => edge.id).sort(), [
    "tunnels_to:host%3Aa:host%3Ab:1",
    "tunnels_to:host%3Aa:host%3Ab:2"
  ]);
  assert.deepEqual(operation.edges.find((edge) => edge.type === "proxy_route")?.properties, { via: "first", transport: "socks" });
  assert.deepEqual(graphStore.query("sessions").nodes.map((node) => node.type).sort(), ["AgentSession", "ShellSession"]);
  graphStore.upsertDelta({
    sourceEventIds: [], nodes: [], edges: [{ id: "ignored-by-canonical-owner", from: "host:a", to: "host:c", type: "tunnels_to", properties: { tunnelId: "1" } }]
  });
  assert.equal(graphStore.query("operation", [], 100).edges.filter((edge) => edge.type === "tunnels_to").length, 3);
  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: [], nodes: [], edges: [{ from: "agent-session:1", to: "host:a", type: "tunnels_to" }]
  }), /Host -> Host/);
  assert.throws(() => graphStore.upsertDelta({
    sourceEventIds: [], nodes: [], edges: [{ from: "host:a", to: "host:b", type: "session_on" }]
  }), /session_on/);
  graphStore.close();
});

test("projection commits return GraphStore canonical operational edge identities", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const graphStore = new SQLiteGraphStore(databasePath, join(runtimeDir, "deltas.jsonl"));
  const runtimeStore = new RuntimeStore(databasePath);
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} }
    ],
    edges: []
  });
  runtimeStore.raiseProjectionDesired("task:projection-edge-id", 1, 1);
  const claim = runtimeStore.claimProjection("task:projection-edge-id");
  assert.ok(claim);
  const committed = graphStore.commitProjection({
    taskId: "task:projection-edge-id",
    fromSeq: 0,
    toSeq: 1,
    generation: claim.generation,
    delta: {
      sourceEventIds: ["event:1"],
      nodes: [],
      edges: [{
        id: "draft-owned-id",
        from: "host:a",
        to: "host:b",
        type: "tunnels_to",
        properties: { tunnelId: "shared" },
        evidenceRefs: ["event:1"]
      }]
    }
  });

  assert.equal(committed.delta.edges[0]?.id, "tunnels_to:host%3Aa:host%3Ab:shared");
  assert.equal(graphStore.query("operation", [], 100).edges[0]?.id, committed.delta.edges[0]?.id);
  runtimeStore.close();
  graphStore.close();
});

test("opening a legacy graph migrates and merges incomplete operational edge ids", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-graph-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const deltaLogPath = join(runtimeDir, "deltas.jsonl");
  const initialStore = new SQLiteGraphStore(databasePath, deltaLogPath);
  initialStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} }
    ],
    edges: []
  });
  initialStore.close();

  const database = new DatabaseSync(databasePath);
  const insert = database.prepare(`
    INSERT INTO edges (id, from_id, to_id, type, properties_json, evidence_refs_json, updated_at)
    VALUES (?, ?, ?, 'tunnels_to', ?, ?, ?)
  `);
  insert.run("tunnel:legacy", "host:a", "host:b", JSON.stringify({ tunnelId: "shared", status: "live" }), JSON.stringify(["event:1"]), "2026-01-01T00:00:00.000Z");
  insert.run("tunnel:legacy-copy", "host:a", "host:b", JSON.stringify({ tunnelId: "shared", transport: "ssh" }), JSON.stringify(["event:2"]), "2026-01-02T00:00:00.000Z");
  database.close();

  const migratedStore = new SQLiteGraphStore(databasePath, deltaLogPath);
  const tunnels = migratedStore.query("operation", [], 100).edges.filter((edge) => edge.type === "tunnels_to");
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0]?.id, "tunnels_to:host%3Aa:host%3Ab:shared");
  assert.deepEqual(tunnels[0]?.properties, { tunnelId: "shared", status: "live", transport: "ssh" });
  assert.deepEqual(tunnels[0]?.evidenceRefs, ["event:1", "event:2"]);
  migratedStore.close();
});
