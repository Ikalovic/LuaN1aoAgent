import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.QINGXUAN_URL || "http://127.0.0.1:5173";
const output = process.env.QINGXUAN_SCREENSHOTS || "/tmp/qingxuan-ui";
await mkdir(output, { recursive: true });

// Browser-only fixtures. No synthetic telemetry is shipped to the application.
const now = Date.now();
const timestamp = new Date(now).toISOString();
const node = (id, type, graphKind, label, properties = {}, evidenceRefs = []) => ({ id, type, graphKind, label, properties, evidenceRefs, updatedAt: timestamp });
const nodes = [
  node("host:gateway", "Host", "operation", "gateway.lab.example", { validationStatus: "validated" }),
  node("host:app", "Host", "operation", "app.lab.example", { validationStatus: "validated" }),
  node("host:db", "Host", "operation", "db.lab.example", { classification: "candidate_only" }),
  node("service:https", "Service", "operation", "HTTPS :443"),
  node("service:api", "Service", "operation", "API :8443"),
  node("service:db", "Service", "operation", "PostgreSQL :5432"),
  node("endpoint:login", "WebEndpoint", "operation", "/account/login"),
  node("endpoint:api", "WebEndpoint", "operation", "/api/v1/status"),
  node("finding:header", "Vulnerability", "reasoning", "响应头信息泄露", {}, ["evidence:header"]),
  node("hypothesis:auth", "Hypothesis", "reasoning", "鉴权边界待验证", { status: "open" }),
  node("task:inventory", "Task", "task", "资产与服务识别", { status: "completed" }),
  node("task:headers", "Task", "task", "响应头证据复核", { status: "completed" }),
  node("task:auth", "Task", "task", "鉴权范围确认", { status: "blocked" }),
  node("task:report", "Task", "task", "整理评估报告", { status: "open" })
];
if (process.env.QINGXUAN_DENSE === "1") {
  nodes.push(...Array.from({ length: 18 }, (_, index) => node(`asset:extra:${index}`, index % 2 ? "WebEndpoint" : "Service", "operation", index % 2 ? `/api/v1/authorization/provider/${index}` : `HTTPS authorization service :${8443 + index}`)));
  nodes.push(...Array.from({ length: 4 }, (_, index) => node(`hypothesis:extra:${index}`, "Hypothesis", "reasoning", `Authentication boundary review ${index + 1}: the service requires credentials before the authorized scope can be verified`, { status: "inconclusive" })));
}
const pairs = [[0, 3], [1, 4], [2, 5], [3, 6], [4, 7], [3, 8], [10, 11], [11, 12], [12, 13]];
const edges = pairs.map(([from, to], index) => ({ id: `edge:${index}`, from: nodes[from].id, to: nodes[to].id, type: "related_to", properties: {}, evidenceRefs: [] }));
if (process.env.QINGXUAN_DENSE === "1") {
  nodes.filter(item => item.id.startsWith("asset:extra:")).forEach((item, index) => edges.push({ id: `edge:extra:${index}`, from: nodes[index % 2 ? 14 + index - 1 : index % 3].id, to: item.id, type: "related_to", properties: {}, evidenceRefs: [] }));
}
const traceItems = Array.from({ length: 16 }, (_, index) => ({
  id: `trace:${index}`, eventId: `event:${index}`, seq: index + 1,
  timestamp: new Date(now - (16 - index) * 60_000).toISOString(),
  taskId: "task:inventory", role: ["planner", "executor", "observer", "runtime"][index % 4],
  eventType: "tool_execution", eventLabel: "证据记录", stage: "execution", title: "资产证据已记录",
  summary: "测试夹具：已记录授权实验环境的服务元数据。", intentSource: "structured", detail: "", evidenceRefs: [], artifactRefs: [], graphNodeRefs: [nodes[index % 8].id], rawEvent: {}
}));
const coverage = (returned, limit, source = "sqlite") => ({ source, state: "complete", returned, limit, truncated: false, skippedRecords: 0 });
const state = {
  runtimeDir: ".agent-runtime/ui-fixture", loadedAt: timestamp,
  overview: {
    goal: { id: "goal:root", label: "实验环境安全评估 · 展示验收", status: "open" }, scope: { id: "scope:root", label: "lab.example", summary: "授权实验环境 · lab.example" },
    graph: { nodeCount: nodes.length, edgeCount: edges.length, byKind: {}, byType: {} },
    events: { count: traceItems.length, byRole: { planner: 4, executor: 4, observer: 4, runtime: 4 }, byType: { tool_execution: 16 } },
    tasks: { count: 4, byStatus: { completed: 2, blocked: 1, open: 1 }, items: nodes.filter(n => n.type === "Task").map(n => ({ id: n.id, label: n.label, status: n.properties.status })) },
    artifacts: { count: 0, totalBytes: 0 }, agents: Object.fromEntries(["planner", "executor", "observer", "runtime"].map(role => [role, { role, timestamp, eventType: "tool_execution", summary: "最近一次证据记录" }]))
  },
  graph: { nodes, edges, source: "sqlite", summary: {} }, traceItems,
  events: traceItems.map(t => ({ id: t.eventId, role: t.role, timestamp: t.timestamp, eventType: t.eventType, summary: t.summary, payload: {} })),
  reports: { taskOutcomes: [], epochOutcomes: [], planningRounds: [] }, artifacts: { records: [], summary: { count: 0, totalBytes: 0 } },
  coverage: { nodes: coverage(nodes.length, 1200), edges: coverage(edges.length, 2400), events: coverage(traceItems.length, 700, "jsonl"), artifacts: coverage(0, 240, "jsonl"), taskOutcomes: coverage(0, 500), epochOutcomes: coverage(0, 1000) }
};
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  const viewports = [{ width: 1920, height: 1080 }, { width: 1536, height: 864 }, { width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 740 }, { width: 3840, height: 2160 }];
  const widths = (process.env.QINGXUAN_WIDTHS || process.env.QINGXUAN_WIDTH || "").split(",").filter(Boolean).map(Number);
  for (const viewport of viewports.filter(value => !widths.length || widths.includes(value.width))) {
    const context = await browser.newContext({ viewport, locale: "zh-CN", deviceScaleFactor: 1, reducedMotion: process.env.QINGXUAN_REDUCED_MOTION === "1" ? "reduce" : "no-preference" });
    if (process.env.QINGXUAN_THEME) await context.addInitScript(theme => localStorage.setItem("qingxuan-theme", theme), process.env.QINGXUAN_THEME);
    const page = await context.newPage();
    const errors = [];
    const unexpectedApi = [];
    const mutations = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await context.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") mutations.push(`${route.request().method()} ${url.pathname}`);
      let body;
      if (url.pathname === "/api/auth/me") body = { user: { id: "fixture-user", username: "fixture", displayName: "验收账号", role: process.env.QINGXUAN_ROLE || "analyst", createdAt: timestamp } };
      else if (url.pathname === "/api/state") body = state;
      else if (url.pathname === "/api/runs") body = { runs: process.env.QINGXUAN_RUNNING === "1" ? [{ runtimeDir: state.runtimeDir, name: "ui-fixture", goal: state.overview.goal.label, scope: "lab.example", taskType: "pentest", startedAt: timestamp, running: true }] : [] };
      else if (url.pathname === "/api/sessions") body = { sessions: [{ name: "ui-fixture", runtimeDir: state.runtimeDir, goal: state.overview.goal.label, source: "sqlite", taskCount: 4, eventCount: 16, nodeCount: nodes.length, edgeCount: edges.length }], summary: { count: 1 }, loadedAt: timestamp, rootDir: ".agent-runtime" };
      else {
        unexpectedApi.push(url.pathname);
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected API in read-only visual check" }) });
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    for (const view of (process.env.QINGXUAN_VIEWS || "overview,wallboard").split(",")) {
      const query = new URLSearchParams(process.env.QINGXUAN_QUERY || "");
      query.set("view", view);
      query.set("runtimeDir", state.runtimeDir);
      await page.goto(`${base}/?${query}`);
      if (view === "wallboard") await page.locator(".wallboard").waitFor({ timeout: 30000 });
      await page.waitForTimeout(3500);
      if (view === "wallboard" && process.env.QINGXUAN_FULLSCREEN === "1") {
        await page.getByRole("button", { name: "切换全屏", exact: true }).click();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
      }
      if (view === "wallboard" && process.env.QINGXUAN_WALL_VISUAL === "1") {
        const metrics = await page.locator(".wall-metric").evaluateAll(items => items.map(item => {
          const label = item.querySelector(":scope > span").getBoundingClientRect();
          const value = item.querySelector(":scope > strong").getBoundingClientRect();
          return { stacked: value.top >= label.bottom - 1, centered: Math.abs((value.left + value.width / 2) - (label.left + label.width / 2)) < 2, fits: item.scrollWidth <= item.clientWidth };
        }));
        assert.ok(metrics.every(item => item.stacked && item.centered && item.fits), "Metric labels and values must be vertically grouped, centered, and contained");
        const backgrounds = await page.locator(".wall-controls-aux, .wall-scene-labels button, .wall-controls .ant-select-selector, .wall-controls .ant-segmented").evaluateAll(items => items.map(item => ({ className: item.className, background: getComputedStyle(item).backgroundColor })).filter(item => item.background !== "rgba(0, 0, 0, 0)"));
        assert.deepEqual(backgrounds, [], "In-page controls and labels must not retain solid background blocks");
      }
      const layout = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        images: Array.from(document.images).filter(img => !img.complete || img.naturalWidth === 0).map(img => img.src),
        canvases: Array.from(document.querySelectorAll("canvas")).map(canvas => ({ width: canvas.width, height: canvas.height, rect: { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height } }))
      }));
      await page.screenshot({ path: `${output}/${view}-${viewport.width}.png`, fullPage: true });
      if (view === "wallboard" && await page.locator(".wall-three canvas").count()) {
        const scene = page.locator(".wall-three canvas");
        const bounds = await scene.boundingBox();
        const rendered = await scene.screenshot();
        await scene.evaluate(element => { element.style.visibility = "hidden"; });
        const background = await page.screenshot({ clip: bounds });
        await scene.evaluate(element => { element.style.visibility = ""; });
        const changed = await page.evaluate(async pair => {
          const samples = await Promise.all(pair.map(async encoded => {
            const img = new Image(); img.src = `data:image/png;base64,${encoded}`; await img.decode();
            const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 128;
            const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0, 256, 128);
            return ctx.getImageData(0, 0, 256, 128).data;
          }));
          let changed = 0;
          for (let i = 0; i < samples[0].length; i += 4) if (Math.abs(samples[0][i] - samples[1][i]) + Math.abs(samples[0][i + 1] - samples[1][i + 1]) + Math.abs(samples[0][i + 2] - samples[1][i + 2]) > 24) changed++;
          return changed;
        }, [rendered.toString("base64"), background.toString("base64")]);
        assert.ok(changed > 80, "3D scene must contribute visible pixels beyond the background image");
      }
      const pixels = [];
      for (const canvas of await page.locator("canvas").all()) {
        const bounds = await canvas.boundingBox();
        if (!bounds || bounds.width < 200 || bounds.height < 200) continue;
        const screenshot = await canvas.screenshot();
        const sample = await page.evaluate(async encoded => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const probe = document.createElement("canvas");
          probe.width = 128;
          probe.height = 128;
          const context = probe.getContext("2d");
          context.drawImage(image, 0, 0, 128, 128);
          const { data } = context.getImageData(0, 0, 128, 128);
          const colors = new Set();
          let visible = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 16) continue;
            visible++;
            colors.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
          }
          return { colors: colors.size, visible };
        }, screenshot.toString("base64"));
        pixels.push(sample);
      }
      results.push({ view, viewport, ...layout, pixels, errors: [...errors], unexpectedApi: [...unexpectedApi], mutations: [...mutations] });
      assert.ok(layout.scrollWidth <= viewport.width + 1, `${view} overflows at ${viewport.width}`);
      assert.deepEqual(layout.images, [], `${view} has broken images`);
      assert.deepEqual(errors, [], `${view} has uncaught errors`);
      assert.deepEqual(unexpectedApi, [], `${view} fetched an unexpected or privileged API`);
      assert.deepEqual(mutations, [], `${view} issued a mutation during passive viewing`);
      if (view === "wallboard") {
        const background = await page.locator(".wall-background img").evaluate(element => element.currentSrc);
        assert.ok(background.endsWith(viewport.width >= 2560 ? "/art/wallboard-surface-v3-4k.webp" : "/art/wallboard-surface-v3-1080.webp"), "Wallboard must load the matching V3 flat background");
        const stageWidth = await page.locator(".wall-stage-graph").evaluate(element => element.clientWidth);
        const graphWidth = await page.locator(".wall-stage-graph canvas").first().evaluate(element => element.getBoundingClientRect().width);
        assert.ok(graphWidth >= stageWidth * .9, "Wallboard graph must fill the central stage in every mode");
        assert.equal(await page.locator(".wall-donut canvas").count(), 2, "Both distribution charts should render");
        assert.equal(await page.locator(".wall-trend-plot canvas").count(), 1, "Event trend should render");
      }
      if (["overview", "operation", "reasoning", "task", "wallboard"].includes(view)) assert.ok(pixels.some(sample => sample.colors > 12 && sample.visible > 128), `${view} has no nonblank graph canvas at ${viewport.width}`);
      if (process.env.QINGXUAN_INTERACTIONS === "1" && view === "overview") {
        const originalTheme = await page.locator("html").getAttribute("data-theme");
        await page.getByRole("button", { name: "切换主题", exact: true }).click();
        assert.notEqual(await page.locator("html").getAttribute("data-theme"), originalTheme);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${output}/overview-theme-${viewport.width}.png` });
        await page.getByRole("button", { name: "切换主题", exact: true }).click();
        await page.locator(".qx-metrics button").filter({ hasText: "漏洞" }).click();
        assert.equal(new URL(page.url()).searchParams.get("view"), "findings");
        assert.equal(new URL(page.url()).searchParams.get("findingType"), "Vulnerability");
        await page.getByRole("button", { name: "响应头信息泄露", exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.get("nodeId"), "finding:header");
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${output}/finding-details-${viewport.width}.png` });
        if (viewport.width >= 1440) await page.getByRole("button", { name: "关闭详情", exact: true }).click();
        else await page.locator(".ant-drawer-close").click();
        assert.equal(new URL(page.url()).searchParams.get("nodeId"), null);
        await page.goBack();
        assert.equal(new URL(page.url()).searchParams.get("view"), "overview");
        await page.goForward();
        assert.equal(new URL(page.url()).searchParams.get("view"), "findings");
        assert.deepEqual(errors, [], "Workbench interactions produced uncaught errors");
        assert.deepEqual(mutations, [], "Read-only workbench interactions issued a mutation");
      }
      if (process.env.QINGXUAN_INTERACTIONS === "1" && view === "wallboard" && viewport.width >= 1280) {
        const canvas = page.locator(".wall-three canvas");
        assert.equal(await canvas.count(), 1, "Desktop wallboard should render its 3D scene");
        const before = await canvas.screenshot();
        if (process.env.QINGXUAN_RUNNING === "1" && process.env.QINGXUAN_REDUCED_MOTION !== "1") {
          await page.waitForTimeout(1200);
          assert.equal(before.equals(await canvas.screenshot()), false, "Active scene should render its subtle material motion");
        }
        const label = page.locator(".wall-scene-labels button:visible").first();
        const id = await label.getAttribute("data-node");
        await label.click();
        await page.waitForTimeout(350);
        assert.equal(new URL(page.url()).searchParams.get("nodeId"), id);
        assert.equal(before.equals(await canvas.screenshot()), false, "Node selection should update scene pixels");
        await page.getByRole("button", { name: "暂停大屏", exact: true }).click();
        await page.getByRole("button", { name: "刷新一次", exact: true }).click();
        await page.waitForTimeout(350);
        assert.equal(await page.getByRole("button", { name: "恢复大屏", exact: true }).count(), 1, "Refresh once should retain paused mode");
        const paused = await canvas.screenshot();
        await page.waitForTimeout(400);
        assert.equal(paused.equals(await canvas.screenshot()), true, "Paused scene should stay still");
        await page.getByRole("button", { name: "切换全屏", exact: true }).click();
        await page.waitForTimeout(250);
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
        await canvas.evaluate(element => element.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext());
        await page.waitForTimeout(1800);
        assert.equal(await page.locator(".wall-three canvas").count(), 0, "Context loss should fall back to a flat graph");
        assert.ok(await page.locator("canvas").count() > 0, "Fallback should retain a graph");
        await page.screenshot({ path: `${output}/wallboard-flat-${viewport.width}.png`, fullPage: true });
        assert.deepEqual(errors, [], "Wallboard interactions produced uncaught errors");
        assert.deepEqual(mutations, [], "Wallboard controls issued a backend mutation");
      }
    }
    await context.close();
  }
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
