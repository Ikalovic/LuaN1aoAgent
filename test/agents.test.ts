import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createExecutorResearchTools, observerToolsForMode } from "../src/agents.js";
import {
  GRAPH_TOOL_MAX_OUTPUT_BYTES,
  createGraphDeltaSubmitTool,
  createGraphQueryTool,
  createGraphSearchTool,
  createGraphTraceTool,
  createPlannerSubmitTool
} from "../src/tools/pi-tools.js";
import {
  aliasProjectionGraphContext,
  expandProjectionDraft,
  ProjectorGraphRefRegistry
} from "../src/projection.js";
import type { ArtifactStore } from "../src/stores/artifact-store.js";
import type { ExecutionLog } from "../src/stores/execution-log.js";
import type { SQLiteGraphStore } from "../src/stores/graph-store.js";
import type { GraphSnapshot } from "../src/types.js";

test("supervisor observer mode exposes only the terminating control tool", () => {
  const tools = observerToolsForMode({
    mode: "supervise",
    graphStore: {} as SQLiteGraphStore,
    executionLog: {} as ExecutionLog,
    artifactStore: {} as ArtifactStore
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["control_submit"]);
});

test("projector observer mode exposes bounded read-only graph tools and the terminating graph tool", () => {
  const tools = observerToolsForMode({
    mode: "project",
    graphStore: {} as SQLiteGraphStore,
    executionLog: {} as ExecutionLog,
    artifactStore: {} as ArtifactStore
  });

  assert.deepEqual(tools.map((tool) => tool.name), [
    "graph_search",
    "graph_query",
    "graph_trace",
    "graph_delta_submit"
  ]);
});

test("executor exposes bounded public research tools", () => {
  assert.deepEqual(
    createExecutorResearchTools().map((tool) => tool.name),
    ["web_fetch", "web_search", "vulnerability_search"]
  );
});

test("projector terminal tool bounds the wire schema and enforces draft semantics with named errors", async () => {
  const tool = createGraphDeltaSubmitTool();
  const schema = tool.parameters as unknown as {
    properties: {
      nodes: {
        maxItems?: number;
        items?: {
          properties?: {
            id?: { pattern?: string };
            graphKind?: { minLength?: number; maxLength?: number };
          };
        };
      };
      edges: {
        maxItems?: number;
        items?: {
          properties?: {
            from?: { pattern?: string };
            to?: { pattern?: string };
          };
        };
      };
      sourceEventIds?: unknown;
    };
    additionalProperties?: boolean;
  };

  // The wire schema only checks field shapes and bounds; vocabulary and
  // connectivity are enforced by validateProjectionDraftIntegrity so model
  // mistakes get actionable feedback instead of opaque schema rejections.
  assert.equal(schema.properties.nodes.maxItems, 24);
  assert.equal(schema.properties.edges.maxItems, 40);
  assert.equal(schema.properties.nodes.items?.properties?.id?.pattern, "^(existing|new):[1-9][0-9]*$");
  assert.equal(schema.properties.edges.items?.properties?.from?.pattern, "^(existing|new):[1-9][0-9]*$");
  assert.equal(schema.properties.edges.items?.properties?.to?.pattern, "^(existing|new):[1-9][0-9]*$");
  assert.equal(schema.properties.sourceEventIds, undefined);
  assert.equal(schema.additionalProperties, false);

  assert.equal(Check(tool.parameters, {
    nodes: [{
      id: "new:1",
      graphKind: "reasoning",
      type: "Evidence",
      label: "HTTP evidence",
      properties: {
        source: "HTTP responses and JS bundle analysis",
        summary: "Observed a valid response"
      },
      evidenceRefs: ["o1"]
    }],
    edges: []
  }), true);
  assert.equal(Check(tool.parameters, {
    nodes: [{
      id: "new:1",
      graphKind: "reasoning",
      type: "Evidence",
      label: "Long evidence",
      properties: { summary: "x".repeat(2_000) },
      evidenceRefs: Array.from({ length: 16 }, (_, index) => `o${index + 1}`)
    }],
    edges: []
  }), true);
  assert.equal(Check(tool.parameters, {
    nodes: [{ id: "bogus:1", graphKind: "reasoning", type: "Evidence", label: "Bad alias" }],
    edges: []
  }), false);

  // Shape-valid but semantically invalid drafts pass the wire schema and are
  // rejected by execute with messages naming the offending node or edge.
  const vocabularyDraft = {
    nodes: [{ id: "new:1", graphKind: "bogus", type: "Nope", label: "Wrong vocabulary" }],
    edges: []
  };
  assert.equal(Check(tool.parameters, vocabularyDraft), true);
  await assert.rejects(
    () => tool.execute(
      "call:projector:vocabulary",
      vocabularyDraft,
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /node at index 0 has graphKind "bogus".*No part of the delta was accepted/
  );
  await assert.rejects(
    () => tool.execute(
      "call:projector:keys",
      {
        nodes: [{ id: "new:1", graphKind: "reasoning", type: "Evidence", label: "Extra keys", status: "confirmed" }],
        edges: []
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /node at index 0 has unexpected top-level keys \[status\].*No part of the delta was accepted/
  );
  await assert.rejects(
    () => tool.execute(
      "call:projector:edgetype",
      {
        nodes: [],
        edges: [{ from: "existing:1", to: "existing:2", type: "depends_on" }]
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /edge at index 0 has type "depends_on".*No part of the delta was accepted/
  );
});

test("projector terminal tool rejects incomplete new-alias closures before terminating", async () => {
  const tool = createGraphDeltaSubmitTool();

  await assert.rejects(
    () => tool.execute(
      "call:projector",
      {
        nodes: [{
          id: "new:7",
          graphKind: "operation",
          type: "Port",
          label: "60.205.226.234:8001",
          properties: { port: 8001 }
        }],
        edges: [{ from: "new:1", to: "new:7", type: "observed_on" }]
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /edges reference undeclared new aliases new:1.*No part of the delta was accepted/
  );
});

test("projector terminal tool enforces one total delta byte boundary", async () => {
  const tool = createGraphDeltaSubmitTool();
  await assert.rejects(
    () => tool.execute(
      "call:projector:oversized",
      {
        nodes: [{
          id: "new:1",
          graphKind: "reasoning",
          type: "Evidence",
          label: "Oversized evidence",
          properties: { summary: "x".repeat(130 * 1024) },
          evidenceRefs: ["o1"]
        }],
        edges: []
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /Projection delta requires .* maximum is 131072/
  );
});

test("projector terminal tool validates existing aliases against only its current graph context", async () => {
  const tool = createGraphDeltaSubmitTool({
    existingAliases: new Map([
      ["existing:1", { graphKind: "operation", type: "Host" }],
      ["existing:2", { graphKind: "reasoning", type: "Evidence" }],
      ["existing:3", { graphKind: "task", type: "Goal" }]
    ])
  });

  await assert.rejects(
    () => tool.execute(
      "call:projector:unknown-existing",
      {
        nodes: [],
        edges: [{ from: "existing:1", to: "existing:4", type: "supports" }]
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /unknown existing aliases existing:4.*No part of the delta was accepted/
  );

  const accepted = await tool.execute(
    "call:projector:known-existing",
    {
      nodes: [{
        id: "existing:1",
        graphKind: "operation",
        type: "Host",
        label: "Updated host",
        properties: { ip: "10.0.0.1" }
      }],
      edges: [{ from: "existing:2", to: "existing:1", type: "observed_on" }]
    },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  assert.equal(accepted.terminate, true);

  await assert.rejects(
    () => tool.execute(
      "call:projector:task-update",
      {
        nodes: [{
          id: "existing:3",
          graphKind: "operation",
          type: "Host",
          label: "Disguised task node",
          properties: {}
        }],
        edges: []
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /cannot mutate task graph aliases existing:3\(Goal\); no part of the delta was accepted/
  );

  await assert.rejects(
    () => tool.execute(
      "call:projector:task-edge",
      { nodes: [], edges: [{ from: "existing:2", to: "existing:3", type: "supports" }] },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /cannot mutate task graph aliases existing:3\(Goal\); no part of the delta was accepted/
  );
});

test("projector rejects unconnected new semantic nodes and accepts an atomic relation", async () => {
  const tool = createGraphDeltaSubmitTool({
    existingAliases: new Map([
      ["existing:1", { graphKind: "operation", type: "WebEndpoint" }]
    ])
  });

  await assert.rejects(
    () => tool.execute(
      "call:projector:unconnected",
      {
        nodes: [{
          id: "new:1",
          graphKind: "reasoning",
          type: "Evidence",
          label: "Observed authentication bypass",
          properties: {}
        }],
        edges: []
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /unconnected semantic nodes new:1/
  );
  const accepted = await tool.execute(
    "call:projector:connected",
    {
      nodes: [{
        id: "new:1",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Observed authentication bypass",
        properties: {}
      }],
      edges: [{ from: "new:1", to: "existing:1", type: "supports" }]
    },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  assert.equal(accepted.terminate, true);
});

test("graph trace returns byte-bounded closed pages with lossless identity continuation", async () => {
  const nodes = Array.from({ length: 80 }, (_, index) => ({
    id: `node:${index}`,
    graphKind: index % 2 === 0 ? "operation" as const : "reasoning" as const,
    type: index % 2 === 0 ? "Host" : "Evidence",
    label: `Node ${index}`,
    properties: {
      routeRef: `route:${index}`,
      ip: `10.0.0.${index}`,
      description: "x".repeat(4_000)
    },
    evidenceRefs: [`event:${index}`]
  }));
  const edges = [
    ...Array.from({ length: 79 }, (_, index) => ({
      id: `edge:${index}`,
      from: `node:${index}`,
      to: `node:${index + 1}`,
      type: "supports",
      properties: { description: "y".repeat(2_000) },
      evidenceRefs: [`event:${index}`]
    })),
    { id: "edge:dangling", from: "node:0", to: "node:missing", type: "supports", properties: {}, evidenceRefs: [] }
  ];
  const snapshot: GraphSnapshot = {
    view: "planner",
    nodes,
    edges,
    summary: { description: "z".repeat(8_000) }
  };
  const graphStore = { trace: () => snapshot } as unknown as SQLiteGraphStore;
  const tool = createGraphTraceTool(graphStore);
  const returnedNodeIds = new Set<string>();
  const returnedEdgeIds = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const result = await tool.execute(
      `call:trace:${pageCount}`,
      { ref: "node:0", ...(cursor ? { cursor } : {}) },
      new AbortController().signal,
      () => undefined,
      {} as never
    );
    const text = result.content[0]?.type === "text" && typeof result.content[0].text === "string"
      ? result.content[0].text
      : "";
    assert.ok(Buffer.byteLength(text, "utf8") <= GRAPH_TOOL_MAX_OUTPUT_BYTES);
    const page = JSON.parse(text) as {
      nodes: Array<{ id: string; properties: Record<string, unknown> }>;
      edges: Array<{ id?: string; from: string; to: string }>;
      page: {
        nextCursor?: string;
        danglingSourceEdgeCount: number;
      };
    };
    const pageNodeIds = new Set(page.nodes.map((node) => node.id));
    assert.ok(page.edges.every((edge) => pageNodeIds.has(edge.from) && pageNodeIds.has(edge.to)));
    if (pageCount === 0) {
      assert.equal(page.nodes[0]?.id, "node:0");
      assert.equal(page.nodes[0]?.properties.routeRef, "route:0");
      assert.equal(page.page.danglingSourceEdgeCount, 1);
    }
    page.nodes.forEach((node) => returnedNodeIds.add(node.id));
    page.edges.forEach((edge) => {
      if (edge.id) returnedEdgeIds.add(edge.id);
    });
    cursor = page.page.nextCursor;
    pageCount += 1;
    assert.ok(pageCount < 200, "graph continuation must make progress");
  } while (cursor);

  assert.equal(returnedNodeIds.size, 80);
  assert.equal(returnedEdgeIds.size, 79);
});

test("projector graph tools share one stable alias namespace through submission", async () => {
  const seedNode = {
    id: "projected:seed-node",
    graphKind: "reasoning" as const,
    type: "Evidence",
    label: "Seed evidence",
    properties: { status: "observed" },
    evidenceRefs: ["event:seed"]
  };
  const discoveredNode = {
    id: "projected:discovered-node",
    graphKind: "operation" as const,
    type: "Host",
    label: "Discovered host",
    properties: { ip: "10.0.0.8" },
    evidenceRefs: ["event:discovered"]
  };
  const graphContext = aliasProjectionGraphContext({ nodes: [seedNode], edges: [] });
  const references = new ProjectorGraphRefRegistry(graphContext);
  let queryFocusNodeIds: string[] | undefined;
  let traceNodeId: string | undefined;
  let searchQuery: string | undefined;
  const graphStore = {
    query: (_view: string, focusNodeIds: string[]) => {
      queryFocusNodeIds = focusNodeIds;
      return {
        view: "planner",
        nodes: [seedNode, discoveredNode],
        edges: [{
          id: "edge:internal",
          from: seedNode.id,
          to: discoveredNode.id,
          type: "observed_on",
          properties: {},
          evidenceRefs: ["event:discovered"]
        }],
        summary: { focusNodeIds: [seedNode.id] }
      } satisfies GraphSnapshot;
    },
    trace: (input: { nodeId?: string }) => {
      traceNodeId = input.nodeId;
      return {
        view: "planner",
        nodes: [discoveredNode],
        edges: [],
        summary: { focusNodeIds: [discoveredNode.id] }
      } satisfies GraphSnapshot;
    },
    searchSemanticNodes: (input: { query: string }) => {
      searchQuery = input.query;
      return {
        view: "operation",
        nodes: [discoveredNode],
        edges: [],
        summary: { query: input.query }
      } satisfies GraphSnapshot;
    }
  } as unknown as SQLiteGraphStore;
  const queryTool = createGraphQueryTool(graphStore, references);
  const traceTool = createGraphTraceTool(graphStore, references);
  const searchTool = createGraphSearchTool(graphStore, references);
  const submitTool = createGraphDeltaSubmitTool({ existingAliases: references.aliasContext() });

  const queryResult = await queryTool.execute(
    "call:projector-query",
    { view: "planner", focusNodeIds: ["existing:1"], limit: 20 },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const queryText = queryResult.content[0]?.type === "text" && typeof queryResult.content[0].text === "string"
    ? queryResult.content[0].text
    : "";
  const queryPage = JSON.parse(queryText) as {
    nodes: Array<{ id: string }>;
    edges: Array<{ id?: string; from: string; to: string }>;
    summary: { focusNodeIds: string[] };
    page: { missingFocusNodeIds: string[] };
  };
  assert.deepEqual(queryFocusNodeIds, [seedNode.id]);
  assert.deepEqual(queryPage.nodes.map((node) => node.id), ["existing:1", "existing:2"]);
  assert.deepEqual(queryPage.edges, [{
    from: "existing:1",
    to: "existing:2",
    type: "observed_on",
    properties: {},
    evidenceRefs: ["event:discovered"]
  }]);
  assert.deepEqual(queryPage.summary.focusNodeIds, ["existing:1"]);
  assert.deepEqual(queryPage.page.missingFocusNodeIds, []);
  assert.doesNotMatch(queryText, /projected:(seed|discovered)-node|edge:internal/);

  const traceResult = await traceTool.execute(
    "call:projector-trace",
    { ref: "existing:2" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const traceText = traceResult.content[0]?.type === "text" && typeof traceResult.content[0].text === "string"
    ? traceResult.content[0].text
    : "";
  assert.equal(traceNodeId, discoveredNode.id);
  assert.equal((JSON.parse(traceText) as { nodes: Array<{ id: string }> }).nodes[0]?.id, "existing:2");
  assert.doesNotMatch(traceText, /projected:discovered-node/);

  const searchResult = await searchTool.execute(
    "call:projector-search",
    { query: "related existing:2" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const searchText = searchResult.content[0]?.type === "text" && typeof searchResult.content[0].text === "string"
    ? searchResult.content[0].text
    : "";
  assert.equal(searchQuery, `related ${discoveredNode.id}`);
  assert.equal((JSON.parse(searchText) as { nodes: Array<{ id: string }> }).nodes[0]?.id, "existing:2");
  assert.doesNotMatch(searchText, /projected:discovered-node/);

  const submitted = await submitTool.execute(
    "call:projector-submit-dynamic",
    { nodes: [], edges: [{ from: "existing:1", to: "existing:2", type: "supports" }] },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  assert.equal(submitted.terminate, true);
  const expanded = expandProjectionDraft({
    value: submitted.details,
    batch: { observations: [], toSeq: 0, sourceEventIds: [] },
    graphContext,
    references
  });
  assert.deepEqual(expanded.edges.map((edge) => [edge.from, edge.to]), [[seedNode.id, discoveredNode.id]]);
});

test("planner graph query keeps real node references without a Projector registry", async () => {
  const node = {
    id: "node:planner-visible",
    graphKind: "operation" as const,
    type: "Host",
    label: "Planner host",
    properties: {},
    evidenceRefs: []
  };
  let receivedFocusNodeIds: string[] | undefined;
  const graphStore = {
    query: (_view: string, focusNodeIds: string[]) => {
      receivedFocusNodeIds = focusNodeIds;
      return { view: "planner", nodes: [node], edges: [], summary: {} } satisfies GraphSnapshot;
    }
  } as unknown as SQLiteGraphStore;
  const tool = createGraphQueryTool(graphStore);
  const result = await tool.execute(
    "call:planner-query",
    { view: "planner", focusNodeIds: [node.id], limit: 20 },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const text = result.content[0]?.type === "text" && typeof result.content[0].text === "string"
    ? result.content[0].text
    : "";
  assert.deepEqual(receivedFocusNodeIds, [node.id]);
  assert.match(text, /node:planner-visible/);
  assert.doesNotMatch(text, /existing:1/);
});

test("graph reads cache only identical calls inside one Projector invocation", async () => {
  let queryCount = 0;
  const graphStore = {
    query: (view: GraphSnapshot["view"]) => {
      queryCount += 1;
      return {
        view,
        nodes: [],
        edges: [],
        summary: { queryCount }
      } satisfies GraphSnapshot;
    }
  } as unknown as SQLiteGraphStore;
  const invocationCache = new Map<string, string>();
  const tool = createGraphQueryTool(graphStore, undefined, invocationCache);
  const execute = (limit: number) => tool.execute(
    `call:cache:${limit}:${queryCount}`,
    { view: "reasoning", focusNodeIds: [], limit },
    new AbortController().signal,
    () => undefined,
    {} as never
  );

  const first = await execute(20);
  const repeated = await execute(20);
  await execute(21);

  assert.equal(queryCount, 2);
  assert.deepEqual(repeated.content, first.content);
});

test("graph trace schema requires one real reference", async () => {
  const graphStore = { trace: () => assert.fail("trace must not run") } as unknown as SQLiteGraphStore;
  const tool = createGraphTraceTool(graphStore);
  assert.equal(Check(tool.parameters, {}), false);
  assert.equal(Check(tool.parameters, { ref: "node:real" }), true);
});

test("graph search surfaces evidence-backed artifact refs as node materialRefs", async () => {
  const credentialNode = {
    id: "projected:credential-1",
    graphKind: "operation" as const,
    type: "Credential",
    label: "Flask session cookie from login",
    properties: { cookieName: "session" },
    evidenceRefs: ["event:login", "event:probe"]
  };
  const snapshot: GraphSnapshot = {
    view: "operation",
    nodes: [credentialNode],
    edges: [],
    summary: {}
  };
  const graphStore = { searchSemanticNodes: () => snapshot } as unknown as SQLiteGraphStore;
  const resolvedEvidenceRefs: string[][] = [];
  const tool = createGraphSearchTool(graphStore, undefined, undefined, (evidenceRefs) => {
    resolvedEvidenceRefs.push([...evidenceRefs]);
    return new Map([
      ["event:login", ["artifact:cookie-jar", "artifact:recon-notes"]],
      ["event:probe", ["artifact:cookie-jar"]]
    ]);
  });

  const result = await tool.execute(
    "call:materials",
    { query: "session cookie" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );

  const text = result.content[0]?.type === "text" && typeof result.content[0].text === "string"
    ? result.content[0].text
    : "";
  const page = JSON.parse(text) as { nodes: Array<{ id: string; materialRefs?: string[] }> };
  assert.deepEqual(resolvedEvidenceRefs, [["event:login", "event:probe"]]);
  assert.deepEqual(page.nodes[0]?.materialRefs, ["artifact:cookie-jar", "artifact:recon-notes"]);

  const toolWithoutResolver = createGraphSearchTool(graphStore);
  const plainResult = await toolWithoutResolver.execute(
    "call:no-materials",
    { query: "session cookie" },
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const plainText = plainResult.content[0]?.type === "text" && typeof plainResult.content[0].text === "string"
    ? plainResult.content[0].text
    : "";
  const plainPage = JSON.parse(plainText) as { nodes: Array<{ materialRefs?: string[] }> };
  assert.equal(plainPage.nodes[0]?.materialRefs, undefined);
});

test("planner terminal tool exposes discriminated command schemas", () => {
  const tool = createPlannerSubmitTool();
  const schema = tool.parameters as unknown as {
    properties: {
      commands: {
        maxItems?: number;
        items?: {
          anyOf?: Array<{
            additionalProperties?: boolean;
            required?: string[];
            properties?: {
              kind?: { const?: string };
              type?: unknown;
              expectedVersion?: unknown;
              tasks?: {
                items?: {
                  required?: string[];
                  properties?: {
                    id?: { pattern?: string };
                    scopeRef?: { pattern?: string };
                  };
                };
              };
            };
          }>;
        };
      };
    };
    additionalProperties?: boolean;
  };
  const branches = schema.properties.commands.items?.anyOf ?? [];

  assert.equal(schema.properties.commands.maxItems, 32);
  assert.deepEqual(
    branches.map((branch) => branch.properties?.kind?.const),
    ["create_tasks", "patch_task", "replace_dependencies", "set_task_status", "set_node_status"]
  );
  assert.ok(branches.every((branch) => branch.additionalProperties === false));
  assert.ok(branches.every((branch) => branch.required?.includes("kind")));
  assert.ok(branches.every((branch) => branch.properties?.type === undefined));
  assert.ok(branches.every((branch) => branch.properties?.expectedVersion === undefined));
  assert.equal(branches[0]?.properties?.tasks?.items?.properties?.id?.pattern, "^task:.+");
  assert.equal(branches[0]?.properties?.tasks?.items?.properties?.scopeRef?.pattern, "^scope:.+");
  assert.equal(schema.additionalProperties, false);
});

test("planner terminal tool validates graph semantics before terminating", async () => {
  let validated = false;
  const tool = createPlannerSubmitTool({
    validate: () => {
      validated = true;
      throw new Error("Dependency graph would contain a cycle: task:a -> task:b -> task:a");
    }
  });

  await assert.rejects(
    () => tool.execute(
      "call:planner",
      {
        decision: "apply_commands",
        commands: [],
        reason: "invalid dependency update",
        basedOnRefs: []
      },
      new AbortController().signal,
      () => undefined,
      {} as never
    ),
    /task:a -> task:b -> task:a/
  );
  assert.equal(validated, true);
});
