import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.QINGXUAN_URL || "http://127.0.0.1:5173";
const output = process.env.QINGXUAN_SCREENSHOTS || "/tmp/qingxuan-entry";
await mkdir(output, { recursive: true });

// All authentication and business responses are browser-only fixtures.
const timestamp = new Date().toISOString();
const user = { id: "entry-fixture", username: "analyst", displayName: "演示账号", role: "analyst", createdAt: timestamp };
const coverage = { source: "sqlite", state: "complete", returned: 0, limit: 1200, truncated: false, skippedRecords: 0 };
const snapshot = {
  runtimeDir: ".agent-runtime/entry-fixture", loadedAt: timestamp,
  overview: {
    goal: { id: "goal:demo", label: "授权实验环境 · 登录回跳验证", status: "completed" },
    graph: { nodeCount: 0, edgeCount: 0, byKind: {}, byType: {} },
    events: { count: 0, byRole: {}, byType: {} }, tasks: { count: 0, byStatus: {}, items: [] },
    artifacts: { count: 0, totalBytes: 0 }, agents: {}
  },
  graph: { nodes: [], edges: [], source: "sqlite", summary: {} }, traceItems: [], events: [],
  reports: { taskOutcomes: [], epochOutcomes: [], planningRounds: [] }, artifacts: { records: [], summary: { count: 0, totalBytes: 0 } },
  coverage: { nodes: coverage, edges: coverage, events: coverage, artifacts: coverage, taskOutcomes: coverage, epochOutcomes: coverage }
};

async function checkLayout(page, selector) {
  const result = await page.locator(selector).evaluate(element => ({
    overflow: element.scrollWidth > element.clientWidth + 1,
    documentOverflow: document.documentElement.scrollWidth > innerWidth,
    broken: [...element.querySelectorAll("img")].filter(image => image.complete && !image.naturalWidth).map(image => image.src),
    width: innerWidth
  }));
  assert.equal(result.overflow, false, `${selector} overflows at ${result.width}`);
  assert.equal(result.documentOverflow, false);
  assert.deepEqual(result.broken, []);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
    const context = await browser.newContext({ viewport, locale: "zh-CN", deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      localStorage.setItem("luanniao-locale", "zh-CN");
      localStorage.setItem("qingxuan-theme", "dark");
    });
    let authenticated = false;
    let attempts = 0;
    const businessRequests = [];
    const unexpected = [];
    const errors = [];
    const modules = [];
    await context.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      let status = 200;
      let body;
      if (pathname === "/api/auth/me") { status = authenticated ? 200 : 401; body = authenticated ? { user } : { error: "请先登录" }; }
      else if (pathname === "/api/auth/csrf") body = { csrfToken: "entry-fixture-csrf" };
      else if (pathname === "/api/auth/login") {
        attempts++;
        authenticated = attempts > 1;
        status = authenticated ? 200 : 401;
        body = authenticated ? { user } : { error: "账号或密码错误" };
      } else if (["/api/state", "/api/runs", "/api/sessions"].includes(pathname)) {
        businessRequests.push(pathname);
        assert.ok(authenticated, "Public entry must not request business data");
        body = pathname === "/api/state" ? snapshot : pathname === "/api/runs" ? { runs: [] } : { sessions: [], summary: { count: 0 }, loadedAt: timestamp, rootDir: ".agent-runtime" };
      } else { unexpected.push(pathname); status = 404; body = { error: "Unexpected fixture endpoint" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.resourceType() === "script") modules.push(request.url()); });
    await page.goto(base);
    await page.getByRole("heading", { name: "青玄", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".qx-home-backdrop").evaluate(image => image.decode());
    await checkLayout(page, ".qx-home");
    const band = await page.locator(".qx-home-overview").boundingBox();
    assert.ok(band.y < viewport.height - 16, "First viewport must show the next section");
    await page.screenshot({ path: `${output}/home-${viewport.width}.png` });
    await page.getByRole("tab", { name: "态势大屏", exact: true }).click();
    await page.locator(".qx-home-product-screen").evaluate(image => image.decode());
    assert.ok((await page.locator(".qx-home-product-screen").getAttribute("src")).endsWith("home-wallboard.webp"));
    await page.locator(".qx-home-overview").evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${output}/home-product-${viewport.width}.png` });
    await page.locator(".qx-home-attribution").scrollIntoViewIfNeeded();
    assert.equal(await page.locator(".qx-home-attribution a").getAttribute("href"), "https://github.com/SanMuzZzZz/LuaN1aoAgent");
    assert.deepEqual(businessRequests, []);
    assert.ok(!modules.some(url => /\/src\/App\.tsx|WallboardScene|ActivityChart|@ant-design_charts|\/three[/.]/.test(url)), "Business and scene modules must not load on public home");

    await page.locator(".qx-home").evaluate(element => { element.scrollTop = 0; });
    await page.locator(".qx-home-actions").getByRole("link", { name: "态势大屏", exact: true }).click();
    await page.getByLabel("用户名", { exact: true }).waitFor();
    await page.waitForURL(url => url.searchParams.get("page") === "login");
    assert.equal(new URL(page.url()).searchParams.get("view"), "wallboard");
    await page.evaluate(() => document.fonts.ready);
    await checkLayout(page, ".qx-auth");
    await page.screenshot({ path: `${output}/login-${viewport.width}.png` });
    await page.getByRole("button", { name: "切换浅色主题", exact: true }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".ant-input-affix-wrapper")).backgroundColor === "rgb(255, 255, 255)");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${output}/login-light-${viewport.width}.png` });
    await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
    await page.getByRole("tab", { name: "注册", exact: true }).click();
    await page.getByLabel("确认密码", { exact: true }).waitFor();
    await checkLayout(page, ".qx-auth");
    await page.getByRole("button", { name: "创建账号并进入", exact: true }).scrollIntoViewIfNeeded();
    const registerButton = await page.getByRole("button", { name: "创建账号并进入", exact: true }).boundingBox();
    assert.ok(registerButton.y >= 0 && registerButton.y + registerButton.height <= viewport.height, "Register submission must stay reachable");
    await page.getByRole("tab", { name: "登录", exact: true }).click();
    await page.goBack();
    await page.locator(".qx-home").waitFor();
    await page.goForward();
    await page.getByLabel("用户名", { exact: true }).waitFor();

    if (viewport.width === 1920) {
      await page.goto(`${base}/?view=wallboard&runtimeDir=${encodeURIComponent(snapshot.runtimeDir)}&wallGraph=task`);
      await page.waitForURL(url => url.searchParams.get("page") === "login");
      await page.getByLabel("用户名", { exact: true }).fill("analyst");
      await page.getByLabel("密码", { exact: true }).fill("fixture-password-only");
      await page.getByRole("button", { name: "登录并继续", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "账号或密码错误" }).waitFor();
      assert.equal(await page.getByLabel("用户名", { exact: true }).inputValue(), "analyst");
      assert.deepEqual(businessRequests, []);
      await page.getByRole("button", { name: "登录并继续", exact: true }).click();
      await page.locator(".wallboard").waitFor({ timeout: 30000 });
      const destination = new URL(page.url()).searchParams;
      assert.equal(destination.get("page"), null);
      assert.equal(destination.get("view"), "wallboard");
      assert.equal(destination.get("runtimeDir"), snapshot.runtimeDir);
      assert.equal(destination.get("wallGraph"), "task");
      await page.goto(`${base}/?view=overview&runtimeDir=${encodeURIComponent(snapshot.runtimeDir)}`);
      await page.getByRole("button", { name: "返回首页", exact: true }).click();
      await page.locator(".qx-home").waitFor();
      const count = businessRequests.length;
      await page.waitForTimeout(5200);
      assert.equal(businessRequests.length, count, "Going home must stop the workbench polling");
      assert.equal(authenticated, true);
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ viewport, status: "passed", errors, unexpected }));
    await context.close();
  }
} finally {
  await browser.close();
}
