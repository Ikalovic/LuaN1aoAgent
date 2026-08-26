# FOFA Topology Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert FOFA subdomains, side-sites, aliases, certificates, hosts, ports, and services into evidence-backed candidate topology nodes, automatically validate them with low-risk checks, and merge validated results into the existing Operation Graph without expanding authorization.

**Architecture:** Add a pure FOFA-record-to-graph normalizer, then let the Observer/Planner pipeline create validation Tasks from pending candidates. Add a narrowly scoped Executor validation tool for DNS/HTTP/TLS/CNAME/redirect checks; validation results become graph deltas with evidence references. Existing GraphStore identity merging remains authoritative.

**Tech Stack:** TypeScript/Node.js, existing FOFA MCP runtime/tools, GraphStore/Projection, Pi Executor tools, Node test runner.

---

### Task 1: Define candidate asset types and graph normalization

**Files:**
- Modify: `src/fofa/fofa-types.ts`
- Create: `src/fofa/fofa-topology.ts`
- Modify: `src/projection.ts`
- Test: `test/fofa-topology.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Cover a FOFA row with host/domain/ip/port/protocol/product/title/cname/certs fields and assert deterministic `Host`, `Port`, `Service`, `WebEndpoint` nodes, `candidate_for`, `resolves_to`, `has_alias`, `has_port`, `runs_service`, and `exposes_endpoint` edges. Assert every node/edge carries the source artifact reference and candidates have `active_testing_allowed=false`.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `npm run build:server && node dist/test/fofa-topology.test.js`

Expected: FAIL because the normalizer does not exist.

- [ ] **Step 3: Implement `normalizeFofaTopology`**

Export:

```ts
export type FofaTopologyInput = {
  records: FofaRecord[];
  evidenceRef: string;
  authorizedAnchors: string[];
};
export type FofaTopologyDelta = Pick<GraphDelta, "nodes" | "edges">;
export function normalizeFofaTopology(input: FofaTopologyInput): FofaTopologyDelta;
```

Normalize host/domain/IP values, derive stable IDs through `stableOperationIdentityId`, set `source`, `classification`, `validationStatus="pending"`, and emit only non-secret properties. Treat `candidate_only` records as candidates even when a field is missing. Use `candidate_for` to connect an external candidate to the nearest authorized anchor; never set `active_testing_allowed=true` for candidates.

- [ ] **Step 4: Extend projection edge validation**

Allow the five topology relationships in `projectionEdgeTypeForEndpoints` and preserve them during graph merge. Keep existing type restrictions and evidence requirements unchanged.

- [ ] **Step 5: Run focused tests**

Run: `npm run build:server && node dist/test/fofa-topology.test.js`

Expected: PASS.

### Task 2: Persist FOFA topology candidates from tool results

**Files:**
- Modify: `src/tools/fofa-mcp-tools.ts`
- Modify: `src/controller.ts`
- Test: `test/fofa-mcp-tools.test.ts`
- Test: `test/controller-fofa-topology.test.ts`

- [ ] **Step 1: Add failing persistence tests**

Assert that a successful `fofa_search` result writes the normal FOFA Artifact and causes an operation graph delta with candidate nodes and evidence references. Assert empty results and provider errors do not write topology nodes.

- [ ] **Step 2: Return a topology-ready result envelope**

Keep the existing bounded model preview, and add a bounded `topology` summary containing candidate identities and the source `artifactRef`. Do not expose raw credentials or full response bodies in node properties.

- [ ] **Step 3: Commit topology delta through the existing Observer path**

When the FOFA tool result event is persisted, enqueue an Observer projection request using the FOFA Artifact/evidence reference. The Observer receives the normalized candidate summary and submits a `graph_delta_submit`; it does not directly mutate GraphStore from the tool implementation.

- [ ] **Step 4: Run focused FOFA/controller tests**

Run: `npm run build:server && node dist/test/fofa-mcp-tools.test.js dist/test/controller-fofa-topology.test.js`

Expected: PASS.

### Task 3: Automatically create low-risk validation Tasks

**Files:**
- Modify: `src/prompts.ts`
- Modify: `src/controller.ts`
- Test: `test/prompts.test.ts`
- Test: `test/controller-fofa-topology.test.ts`

- [ ] **Step 1: Add failing planner-prompt tests**

Assert that Planner guidance recognizes `validationStatus=pending` candidate nodes and creates a validation Task with DNS/HTTP/TLS/CNAME/redirect success criteria, while explicitly excluding vulnerability scans, directory enumeration, login attempts, and exploitation.

- [ ] **Step 2: Add candidate-validation planning rules**

Extend Planner system instructions with the candidate lifecycle. A pending candidate becomes a validation Task only once; validated/rejected candidates are not re-queued unless their validation evidence is stale or the node changed materially.

- [ ] **Step 3: Add validation Task success criteria**

Document that the Executor must return evidence for each attempted signal and that completion only means the low-risk validation completed, not that authorization expanded. The Task must include the candidate node ID and source Artifact in `basedOnRefs`.

- [ ] **Step 4: Run prompt/controller tests**

Run: `npm run build:server && node dist/test/prompts.test.js dist/test/controller-fofa-topology.test.js`

Expected: PASS.

### Task 4: Implement the low-risk candidate validation tool

**Files:**
- Create: `src/tools/topology-validation-tool.ts`
- Modify: `src/controller.ts`
- Modify: `src/types.ts` only if a tool result type is needed
- Test: `test/topology-validation-tool.test.ts`

- [ ] **Step 1: Write failing tool tests**

Mock DNS, HTTP, and TLS probes. Assert the tool returns normalized signals, target identity, status, redirects, CNAME/SAN names, and no exploit actions. Assert candidates outside the original scope remain `active_testing_allowed=false`.

- [ ] **Step 2: Implement bounded validation**

Expose one Executor tool, `validate_candidate_asset`, with parameters `{candidate, checks}` where checks is a subset of `dns|http|tls|cname|redirect`. Enforce a fixed timeout, response-size cap, redirect limit, and allowed schemes `http/https`. Never send credentials or mutation requests.

- [ ] **Step 3: Register the tool only for validation Tasks**

Add it to `createTaskRuntimeTools` only when the Task goal or a task property marks it as candidate validation. Keep FOFA and normal network tools unchanged for other Tasks.

- [ ] **Step 4: Run focused tool tests**

Run: `npm run build:server && node dist/test/topology-validation-tool.test.js`

Expected: PASS.

### Task 5: Promote validation results through Observer graph deltas

**Files:**
- Modify: `src/prompts.ts`
- Modify: `src/projection.ts`
- Modify: `src/controller.ts`
- Test: `test/topology-validation-projection.test.ts`

- [ ] **Step 1: Add failing promotion tests**

Given a candidate node and validation evidence, assert a delta updates `validationStatus` to `validated`, records `validationSignals`, adds `validated_by`, `resolves_to`, `has_alias`, and service/endpoint enrichment, and preserves `active_testing_allowed=false`.

- [ ] **Step 2: Extend Observer guidance**

Require graph deltas to reference the validation event/artifact directly. Merge multiple signals into one node update and use stable operation identities so FOFA, DNS, HTTP, TLS, nmap, and fingerprint observations enrich rather than duplicate nodes.

- [ ] **Step 3: Handle failed/inconclusive checks**

Use `rejected` only when a validation signal definitively contradicts the candidate; otherwise retain `pending` with a negative/inconclusive evidence note. Do not delete the candidate node or treat a failed HTTP request as proof the asset does not exist.

- [ ] **Step 4: Run promotion tests**

Run: `npm run build:server && node dist/test/topology-validation-projection.test.js`

Expected: PASS.

### Task 6: Verify integration and document behavior

**Files:**
- Modify: `说明.md`
- Modify: `README_CN.md` if needed
- Test: existing FOFA, graph, projection, controller, and Web suites

- [ ] **Step 1: Document the candidate lifecycle**

Explain FOFA discovery, candidate status, automatic low-risk validation, topology promotion, evidence refs, and the rule that validation never expands authorized Scope.

- [ ] **Step 2: Run builds and focused regressions**

Run: `npm run build:server && npm run build:web && node dist/test/fofa-topology.test.js dist/test/topology-validation-tool.test.js dist/test/topology-validation-projection.test.js && npm run test:web`.

Expected: builds pass, new tests pass, and the 59-test Web suite remains green.

- [ ] **Step 3: Run `git diff --check` and record baseline failures**

Run: `git diff --check` and the repository test command. Record unrelated network/sandbox failures without attributing them to topology changes.

- [ ] **Step 4: Commit implementation when complete**

Use separate commits for normalization, persistence/planning, validation tool, projection promotion, and documentation. Push only after verification.

