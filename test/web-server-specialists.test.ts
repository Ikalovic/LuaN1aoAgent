import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

type SpecialistOptionView = {
  key: string;
  value: unknown;
  isDefault: boolean;
  authority: "author" | "planner" | "user";
  editable: boolean;
  boundOnly: boolean;
  bounds?: { minimum?: number; maximum?: number; allowed?: string[] };
  authorDefault?: unknown;
  spec: {
    type: string;
    minimum?: number;
    maximum?: number;
    maxItems?: number;
    options?: Array<{ value: string; label: string }>;
  };
};

type SpecialistView = {
  id: string;
  source: string;
  enabled: boolean;
  valid: boolean;
  executability: string;
  skillMode: string;
  disabledGroups: string[];
  budget: { defaultMaxTurns: number; maxTurnsCeiling: number; epochTurnSlice: number; epochTimeShare: number };
  optionsMode: "planner" | "user";
  authorOptionsMode: "planner" | "user";
  options: SpecialistOptionView[];
  diagnostics: Array<{ code: string; message: string }>;
};

type Fixture = {
  baseUrl: string;
  root: string;
  project: string;
  process: ChildProcess;
  adminCookie: string;
  anonymousCookie: string;
  jsonHeaders: Record<string, string>;
};

/**
 * Deterministic option schema for the authority contract. The built-in
 * Specialists are authored elsewhere and may change; this project-level Agent
 * pins exactly one option of each authority so the Web contract is asserted
 * against a fixture rather than against whatever the built-ins currently say.
 */
const PROBE_MANIFEST = {
  id: "probe",
  name: "Probe Agent",
  description: "Deterministic fixture for the option authority contract.",
  prompt: { mode: "extend", content: "Probe fixture prompt without placeholders." },
  options: {
    pinned: { type: "string", title: "Pinned label", default: "fixed", authority: "author" },
    limit: { type: "number", title: "Attempt ceiling", default: 8, minimum: 1, maximum: 32, integer: true },
    allowed: { type: "string-list", title: "Allowed protocols", default: ["ssh", "http-post-form"], maxItems: 8 },
    label: { type: "string", title: "Free label", default: "none", authority: "user" }
  }
};

let fixture: Fixture;

test.before(async () => {
  fixture = await createFixture();
});

test.after(async () => {
  if (fixture) await destroyFixture(fixture);
});

test("Web API lists Specialist Agents and persists operator toggles and options", async () => {
  const { baseUrl, jsonHeaders, adminCookie } = fixture;

  const listed = await fetch(`${baseUrl}/api/agents`, { headers: { cookie: adminCookie } });
  assert.equal(listed.status, 200);
  const snapshot = await listed.json() as { specialists: SpecialistView[]; diagnostics: Array<{ code: string }> };
  assert.deepEqual(snapshot.specialists.map((entry) => entry.id), ["bruteforce", "general", "internet-osint", "probe"]);
  const bruteforce = snapshot.specialists[0]!;
  assert.equal(bruteforce.source, "builtin");
  assert.equal(bruteforce.enabled, true);
  assert.equal(bruteforce.valid, true);
  assert.equal(bruteforce.executability, "prompt-only");
  assert.equal(bruteforce.optionsMode, "planner");
  assert.equal(bruteforce.authorOptionsMode, "planner");
  for (const key of ["defaultMaxTurns", "maxTurnsCeiling", "epochTurnSlice", "epochTimeShare"] as const) {
    assert.equal(typeof bruteforce.budget[key], "number");
  }

  // Every option carries a self-consistent authority projection; this is what
  // the capability page renders instead of guessing from the option type.
  for (const specialist of snapshot.specialists) {
    for (const option of specialist.options) {
      assert.equal(option.editable, option.authority !== "author", `${specialist.id}.${option.key} editable`);
      assert.equal(
        option.boundOnly,
        option.authority === "planner" && option.spec.type === "number",
        `${specialist.id}.${option.key} boundOnly`
      );
      assert.notEqual(option.authorDefault, undefined, `${specialist.id}.${option.key} authorDefault`);
      if (!option.editable) assert.equal(option.bounds, undefined, `${specialist.id}.${option.key} author bounds`);
    }
  }

  const probe = snapshot.specialists.find((entry) => entry.id === "probe")!;
  assert.equal(probe.source, "project");
  assert.equal(probe.valid, true);
  assert.deepEqual(probe.options.map((option) => option.key), ["pinned", "limit", "allowed", "label"]);
  const pinned = optionView(probe, "pinned");
  assert.equal(pinned.value, "fixed");
  assert.equal(pinned.isDefault, true);
  assert.equal(pinned.authority, "author");
  assert.equal(pinned.editable, false);
  assert.equal(pinned.boundOnly, false);
  assert.equal(pinned.authorDefault, "fixed");
  assert.equal(pinned.bounds, undefined);
  assert.equal(optionView(probe, "limit").authority, "planner");
  assert.equal(optionView(probe, "limit").editable, true);
  assert.equal(optionView(probe, "limit").boundOnly, true);
  assert.deepEqual(optionView(probe, "limit").bounds, { minimum: 1, maximum: 32 });
  assert.equal(optionView(probe, "limit").authorDefault, 8);
  assert.equal(optionView(probe, "limit").value, 8);
  assert.equal(optionView(probe, "allowed").authority, "planner");
  assert.equal(optionView(probe, "allowed").boundOnly, false);
  assert.deepEqual(optionView(probe, "allowed").bounds, { allowed: ["ssh", "http-post-form"] });
  assert.equal(optionView(probe, "label").authority, "user");
  assert.equal(optionView(probe, "label").editable, true);
  assert.equal(optionView(probe, "label").bounds, undefined);

  const toggled = await fetch(`${baseUrl}/api/agents/bruteforce/state`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(toggled.status, 200);
  assert.equal((await toggled.json() as SpecialistView).enabled, false);
  const state = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.equal(state.bruteforce.enabled, false);

  const required = await fetch(`${baseUrl}/api/agents/general/state`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(required.status, 400);
  assert.equal((await required.json() as { error: { code: string } }).error.code, "invalid_request");

  const configured = await fetch(`${baseUrl}/api/agents/probe/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { limit: 12, label: "custom" } })
  });
  assert.equal(configured.status, 200);
  const configuredView = await configured.json() as SpecialistView;
  // A planner number stores a boundary: the operator's 12 becomes the ceiling
  // while the effective value stays the author default for the Planner to move.
  assert.deepEqual(optionView(configuredView, "limit").bounds, { minimum: 1, maximum: 12 });
  assert.equal(optionView(configuredView, "limit").value, 8);
  assert.equal(optionView(configuredView, "limit").isDefault, true);
  assert.equal(optionView(configuredView, "limit").authorDefault, 8);
  assert.equal(optionView(configuredView, "label").value, "custom");
  assert.equal(optionView(configuredView, "label").isDefault, false);
  const persisted = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.deepEqual(persisted.probe.options, { limit: 12, label: "custom" });

  // Author-owned options are the Specialist's capability envelope: writing one
  // must fail the whole request instead of appearing to loosen a fixed limit.
  const authorFixed = await fetch(`${baseUrl}/api/agents/probe/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { pinned: "hacked" } })
  });
  assert.equal(authorFixed.status, 400);
  const authorFixedBody = await authorFixed.json() as { error: { code: string; message: string } };
  assert.equal(authorFixedBody.error.code, "invalid_request");
  assert.match(authorFixedBody.error.message, /cannot be configured/);
  const afterRejection = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.deepEqual(afterRejection.probe.options, { limit: 12, label: "custom" });

  const mixedAuthorFixed = await fetch(`${baseUrl}/api/agents/probe/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { limit: 16, pinned: "hacked" } })
  });
  assert.equal(mixedAuthorFixed.status, 400);
  const afterMixedRejection = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.deepEqual(afterMixedRejection.probe.options, { limit: 12, label: "custom" });

  const invalidOption = await fetch(`${baseUrl}/api/agents/probe/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { limit: 999 } })
  });
  assert.equal(invalidOption.status, 400);
  assert.equal((await invalidOption.json() as { error: { code: string } }).error.code, "invalid_request");

  const unknownOption = await fetch(`${baseUrl}/api/agents/probe/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { ghost: 1 } })
  });
  assert.equal(unknownOption.status, 400);

  const unknownAgent = await fetch(`${baseUrl}/api/agents/ghost/state`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(unknownAgent.status, 404);
  assert.equal((await unknownAgent.json() as { error: { code: string } }).error.code, "specialist_not_found");

  const badId = await fetch(`${baseUrl}/api/agents/Bad_Id/state`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(badId.status, 400);

  const badBody = await fetch(`${baseUrl}/api/agents/bruteforce/state`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ enabled: "yes" })
  });
  assert.equal(badBody.status, 400);

  const badMethod = await fetch(`${baseUrl}/api/agents`, { method: "POST", headers: jsonHeaders, body: "{}" });
  assert.equal(badMethod.status, 405);
});

test("Web API switches the Agent-wide option authority mode", async () => {
  const { baseUrl, jsonHeaders, adminCookie, anonymousCookie } = fixture;

  const listed = await fetch(`${baseUrl}/api/agents`, { headers: { cookie: adminCookie } });
  const authorMode = (await listed.json() as { specialists: SpecialistView[] })
    .specialists.find((entry) => entry.id === "probe")!.authorOptionsMode;
  const targetMode = authorMode === "planner" ? "user" : "planner";

  const switched = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mode: targetMode })
  });
  assert.equal(switched.status, 200);
  const switchedView = await switched.json() as SpecialistView;
  assert.equal(switchedView.optionsMode, targetMode);
  assert.equal(switchedView.authorOptionsMode, authorMode);
  // An explicit `authority: "author"` override survives any mode change.
  assert.equal(optionView(switchedView, "pinned").authority, "author");
  assert.equal(optionView(switchedView, "pinned").editable, false);
  // The Agent-level mode decides every option that has no override of its own.
  assert.equal(optionView(switchedView, "limit").authority, targetMode);
  assert.equal(optionView(switchedView, "allowed").authority, targetMode);
  assert.equal(optionView(switchedView, "label").authority, "user");
  const modeState = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.equal(modeState.probe.optionsMode, targetMode);

  // The author-fixed key stays rejected in the relaxed mode.
  const stillFixed = await fetch(`${baseUrl}/api/agents/probe/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { pinned: "hacked" } })
  });
  assert.equal(stillFixed.status, 400);

  // `null` resets to the mode the author declared.
  const reset = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mode: null })
  });
  assert.equal(reset.status, 200);
  const resetView = await reset.json() as SpecialistView;
  assert.equal(resetView.optionsMode, authorMode);
  assert.equal(optionView(resetView, "pinned").editable, false);
  const resetState = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.equal(resetState.probe.optionsMode, undefined);

  // An omitted mode is the same reset request.
  const omitted = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({})
  });
  assert.equal(omitted.status, 200);
  assert.equal((await omitted.json() as SpecialistView).optionsMode, authorMode);

  const invalidMode = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mode: "author" })
  });
  assert.equal(invalidMode.status, 400);
  assert.equal((await invalidMode.json() as { error: { code: string } }).error.code, "invalid_request");

  const badShape = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mode: "user", extra: true })
  });
  assert.equal(badShape.status, 400);

  const unknownAgent = await fetch(`${baseUrl}/api/agents/ghost/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mode: "user" })
  });
  assert.equal(unknownAgent.status, 404);
  assert.equal((await unknownAgent.json() as { error: { code: string } }).error.code, "specialist_not_found");

  const badId = await fetch(`${baseUrl}/api/agents/Bad_Id/options-mode`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ mode: "user" })
  });
  assert.equal(badId.status, 400);

  // `operator:mutate` is the route's capability; a request without a session is
  // rejected before the registry is touched.
  const anonymous = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "POST",
    headers: { ...jsonHeaders, cookie: anonymousCookie },
    body: JSON.stringify({ mode: "user" })
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { error: { code: string } }).error.code, "unauthorized");
  const afterAnonymous = JSON.parse(await readFile(join(fixture.project, ".agents", "specialists-state.json"), "utf8"));
  assert.equal(afterAnonymous.probe.optionsMode, undefined);

  const badMethod = await fetch(`${baseUrl}/api/agents/probe/options-mode`, {
    method: "GET",
    headers: { cookie: adminCookie }
  });
  assert.equal(badMethod.status, 405);
});

function optionView(specialist: SpecialistView, key: string): SpecialistOptionView {
  const option = specialist.options.find((candidate) => candidate.key === key);
  assert.ok(option, `missing option ${key}`);
  return option;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "web-specialists-"));
  const project = join(root, "project");
  const runtime = join(project, ".agent-runtime");
  const probeDir = join(project, ".agents", "specialists", "probe");
  await mkdir(runtime, { recursive: true });
  await mkdir(probeDir, { recursive: true });
  await writeFile(join(probeDir, "specialist.json"), JSON.stringify(PROBE_MANIFEST, null, 2));
  const auth = new WebAuthService(join(runtime, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-123" });
  auth.close();
  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"),
    "--runtime-dir", runtime,
    "--auth-db", join(runtime, "auth.sqlite"),
    "--port", String(port)
  ], { cwd: project, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "specialist-csrf";
  const adminCookie = `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrf}`;
  await waitForServer(child, baseUrl);
  return {
    baseUrl,
    root,
    project,
    process: child,
    adminCookie,
    // CSRF is satisfied without a session so the route's own auth check answers.
    anonymousCookie: `luanniao_csrf=${csrf}`,
    jsonHeaders: { "content-type": "application/json", cookie: adminCookie, "x-csrf-token": csrf }
  };
}

async function destroyFixture(active: Fixture): Promise<void> {
  if (active.process.exitCode === null && active.process.signalCode === null) {
    active.process.kill("SIGTERM");
    await new Promise((done) => active.process.once("exit", done));
  }
  await rm(active.root, { recursive: true, force: true });
}

async function reservePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`web server exited with code ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/api/auth/csrf`)).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("web server did not become ready");
}

test("Web API serves the option types only internet-osint declares", async () => {
  const { baseUrl, jsonHeaders, adminCookie } = fixture;

  // Before this Specialist shipped, no builtin declared `enum` or `string-list`,
  // so the manifest validator, the /api/agents projection and the config-page
  // renderer had never carried those shapes in production data.
  const listed = await fetch(`${baseUrl}/api/agents`, { headers: { cookie: adminCookie } });
  const snapshot = await listed.json() as { specialists: SpecialistView[]; diagnostics: Array<{ code: string }> };
  const osint = snapshot.specialists.find((entry) => entry.id === "internet-osint");
  assert.ok(osint, "internet-osint must be listed");
  assert.equal(osint.source, "builtin");
  assert.equal(osint.valid, true);
  assert.equal(osint.options.length, 14);
  assert.deepEqual([...osint.disabledGroups].sort(), [
    "beekeeper", "connectivity", "credentials", "fofa", "network_diagnostics"
  ]);

  const goal = optionView(osint, "collectionGoal");
  assert.equal(goal.spec.type, "enum");
  assert.deepEqual(goal.spec.options, [
    { value: "all", label: "全部" },
    { value: "assets", label: "资产与攻击面" },
    { value: "system", label: "系统信息" },
    { value: "contact", label: "联系方式" },
    { value: "people", label: "人员信息" }
  ]);
  assert.equal(goal.value, "all");
  assert.equal(goal.authority, "user");
  assert.equal(goal.editable, true);

  const sources = optionView(osint, "sources");
  assert.equal(sources.spec.type, "string-list");
  assert.deepEqual(sources.value, ["sogou", "so360", "bing"]);
  assert.equal(sources.spec.maxItems, 3);
  assert.equal(sources.authority, "user");

  // The author pinned the two method invariants.
  assert.equal(optionView(osint, "writeGraphMemory").authority, "author");
  assert.equal(optionView(osint, "writeGraphMemory").editable, false);
  // And the Planner only gets boundaries, not values.
  assert.equal(optionView(osint, "maxRounds").boundOnly, true);
  assert.deepEqual(optionView(osint, "maxRounds").bounds, { minimum: 1, maximum: 12 });

  // Operator writes round-trip through the API for both new types.
  const configured = await fetch(`${baseUrl}/api/agents/internet-osint/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      options: { collectionGoal: "contact", sources: ["sogou", "so360"], minConfidence: "observed" }
    })
  });
  assert.equal(configured.status, 200);
  const configuredView = await configured.json() as SpecialistView;
  assert.equal(optionView(configuredView, "collectionGoal").value, "contact");
  assert.deepEqual(optionView(configuredView, "sources").value, ["sogou", "so360"]);
  assert.equal(optionView(configuredView, "minConfidence").value, "observed");
  assert.equal(optionView(configuredView, "collectionGoal").isDefault, false);
  assert.equal(optionView(configuredView, "readPages").isDefault, true, "untouched options stay at their default");

  // An enum value outside the declared set is rejected, not coerced.
  const badEnum = await fetch(`${baseUrl}/api/agents/internet-osint/options`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ options: { collectionGoal: "everything" } })
  });
  assert.equal(badEnum.status, 400);
});
