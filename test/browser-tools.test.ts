import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChromeArgs,
  renderWithChrome,
  resolveChromePath,
  validateBrowserUrl
} from "../src/tools/browser-tools.js";

test("validateBrowserUrl accepts HTTP and HTTPS only", () => {
  assert.deepEqual(validateBrowserUrl("https://target.test/page?x=1"), {
    ok: true,
    url: "https://target.test/page?x=1"
  });
  assert.equal(validateBrowserUrl("http://target.test:8000/path?x=%3Cimg%3E").ok, true);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://version", "not-a-url"]) {
    assert.equal(validateBrowserUrl(bad).ok, false, bad);
  }
});

test("buildChromeArgs uses a bounded isolated headless profile", () => {
  const args = buildChromeArgs({
    url: "http://target.test/",
    waitMs: 5_000,
    profileDir: "/tmp/profile-x"
  });
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--dump-dom"));
  assert.ok(args.includes("--virtual-time-budget=5000"));
  assert.ok(args.includes("--user-data-dir=/tmp/profile-x"));
  assert.equal(args.includes("--no-sandbox"), false);
  assert.equal(args.some((argument) => argument.includes("--proxy-server")), false);
  assert.equal(args.at(-1), "http://target.test/");
});

test("buildChromeArgs supports Docker isolation without injecting a proxy", () => {
  const args = buildChromeArgs({
    url: "http://target.test/",
    waitMs: 5_000,
    profileDir: "/tmp/profile-x",
    disableChromeSandbox: true,
    ignoreCertificateErrors: true
  });
  assert.ok(args.includes("--no-sandbox"));
  assert.ok(args.includes("--ignore-certificate-errors"));
  assert.equal(args.some((argument) => argument.includes("--proxy-server")), false);
});

test("resolveChromePath prefers explicit environment overrides", () => {
  const found = resolveChromePath(
    { LUANNIAO_CHROME_PATH: "/opt/custom/chrome" },
    "darwin",
    (candidate) => candidate === "/opt/custom/chrome"
  );
  assert.equal(found, "/opt/custom/chrome");
  assert.equal(
    resolveChromePath({}, "darwin", (candidate) => candidate.includes("Google Chrome.app")),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
});

test("renderWithChrome rejects non-HTTP URLs before launching", async () => {
  let launched = false;
  const result = await renderWithChrome("file:///etc/passwd", {
    chromePath: "/fake/chrome",
    execChrome: async () => {
      launched = true;
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }
  });
  assert.equal(result.success, false);
  assert.match(String(result.error), /scheme/);
  assert.equal(launched, false);
});

test("renderWithChrome reports truncation and returns post-JavaScript DOM", async () => {
  const dom = `<html><body>${"x".repeat(500)}<div data-xss="confirmed"></div></body></html>`;
  const result = await renderWithChrome("http://target.test/?search=%3Cimg%3E", {
    chromePath: "/fake/chrome",
    env: {},
    maxChars: 200,
    execChrome: async (chromePath, args) => {
      assert.equal(chromePath, "/fake/chrome");
      assert.equal(args.at(-1), "http://target.test/?search=%3Cimg%3E");
      return { code: 0, signal: null, stdout: dom, stderr: "" };
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.truncated, true);
  assert.equal(result.domChars, dom.length);
  assert.equal(String(result.dom).length, 200);
});

test("renderWithChrome surfaces browser failures instead of empty success", async () => {
  const result = await renderWithChrome("http://target.test/", {
    chromePath: "/fake/chrome",
    env: {},
    execChrome: async () => ({ code: 1, signal: null, stdout: "", stderr: "boom" })
  });
  assert.equal(result.success, false);
  assert.match(String(result.error), /boom/);
});
