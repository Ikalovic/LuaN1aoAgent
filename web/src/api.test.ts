import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConnections, fetchTrafficBody, fetchTrafficHistory, mutateRoute, replayTrafficExchange, runtimeRoot, startRun } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtimeRoot", () => {
  it("keeps agent runtime sessions under the shared root", () => {
    expect(runtimeRoot(".agent-runtime/session-a")).toBe(".agent-runtime");
    expect(runtimeRoot(".agent-runtime")).toBe(".agent-runtime");
  });

  it("uses external runtime directories as their own root", () => {
    expect(runtimeRoot("/tmp/agent-run")).toBe("/tmp/agent-run");
  });
});

describe("traffic API", () => {
  it("builds cursor, filter and bounded body queries", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [], has_more: false }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTrafficHistory(".agent-runtime/sessions/a", {
      cursor: "opaque cursor",
      limit: 25,
      filters: { method: "POST", host: "target.test", status: 201, task_ref: "task:1", run_ref: "run:1", mode: "mitm", error: "true" }
    });
    await fetchTrafficBody(".agent-runtime/sessions/a", "legacy:42", "request", 999999);
    await fetchTrafficBody(".agent-runtime/sessions/a", "task:one:flow/http", "response");

    const historyUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(historyUrl.pathname).toBe("/api/traffic/history");
    expect(Object.fromEntries(historyUrl.searchParams)).toMatchObject({
      runtimeDir: ".agent-runtime/sessions/a", cursor: "opaque cursor", limit: "25", method: "POST", host: "target.test", status: "201", task_ref: "task:1", run_ref: "run:1", mode: "mitm", error: "true"
    });
    const bodyUrl = new URL(String(fetchMock.mock.calls[1]?.[0]), "http://localhost");
    expect(bodyUrl.pathname).toBe("/api/traffic/history/legacy%3A42/body");
    expect(bodyUrl.searchParams.get("byteLimit")).toBe(String(256 * 1024));
    const opaqueBodyUrl = new URL(String(fetchMock.mock.calls[2]?.[0]), "http://localhost");
    expect(opaqueBodyUrl.pathname).toBe("/api/traffic/history/task%3Aone%3Aflow%2Fhttp/body");
  });
});

describe("mutation CSRF handling", () => {
  it("fetches a token and attaches it to state-changing and replay requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ csrfToken: "csrf-test-token" }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ runtimeDir: ".agent-runtime/sessions/test" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ exchangeId: "legacy:9", replayOf: "legacy:7", status: 200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ exchangeId: "replay:2", replayOf: "task:one:flow/http", status: 200 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ connections: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "connectivity-tunnel:test" }) });
    vi.stubGlobal("fetch", fetchMock);

    await startRun({ goal: "test goal", scope: "test scope" });
    await replayTrafficExchange("legacy:7", {
      runtimeDir: ".agent-runtime/sessions/test",
      method: "POST",
      url: "https://target.test/path",
      headers: [{ name: "X-Test", value: "one", ordinal: 0 }, { name: "X-Test", value: "two", ordinal: 1 }],
      body: { encoding: "base64", data: "dGVzdA==" },
      task_ref: "task:1"
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/csrf", { cache: "no-store", credentials: "same-origin" });
    const [, startOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(startOptions.method).toBe("POST");
    expect(new Headers(startOptions.headers).get("X-CSRF-Token")).toBe("csrf-test-token");
    const [replayUrl, replayOptions] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(replayUrl).toBe("/api/traffic/history/legacy%3A7/replay");
    expect(new Headers(replayOptions.headers).get("X-CSRF-Token")).toBe("csrf-test-token");
    expect(JSON.parse(String(replayOptions.body))).toEqual({
      runtimeDir: ".agent-runtime/sessions/test", method: "POST", url: "https://target.test/path",
      headers: [{ name: "X-Test", value: "one", ordinal: 0 }, { name: "X-Test", value: "two", ordinal: 1 }],
      body: { encoding: "base64", data: "dGVzdA==" }, task_ref: "task:1"
    });
    expect(replayUrl).not.toContain("target.test");
    expect(replayUrl).not.toContain("dGVzdA");

    await replayTrafficExchange("task:one:flow/http", { runtimeDir: ".agent-runtime/sessions/test" });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/traffic/history/task%3Aone%3Aflow%2Fhttp/replay");

    await fetchConnections(".agent-runtime/sessions/test");
    await mutateRoute(".agent-runtime/sessions/test", "connectivity-route:test/id", "reconnect");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/connectivity?runtimeDir=.agent-runtime%2Fsessions%2Ftest");
    const [connectionUrl, connectionOptions] = fetchMock.mock.calls[5] as [string, RequestInit];
    expect(connectionUrl).toBe("/api/connectivity/connectivity-route%3Atest%2Fid/reconnect");
    expect(new Headers(connectionOptions.headers).get("X-CSRF-Token")).toBe("csrf-test-token");
    expect(JSON.parse(String(connectionOptions.body))).toEqual({ runtimeDir: ".agent-runtime/sessions/test" });
  });
});

describe("skills API", () => {
  it("lists skills and posts encoded state changes with CSRF", async () => {
    vi.resetModules();
    const { fetchSkills, setSkillEnabled } = await import("./api");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ skills: [], diagnostics: [], scannedAt: "2026-08-30T00:00:00.000Z" })
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ csrfToken: "skills-csrf" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: "ctf/web", enabled: false }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchSkills();
    await setSkillEnabled("ctf/web", false);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/skills");
    const [url, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("/api/skills/ctf%2Fweb/state");
    expect(new Headers(options.headers).get("X-CSRF-Token")).toBe("skills-csrf");
    expect(JSON.parse(String(options.body))).toEqual({ enabled: false });
  });
});
