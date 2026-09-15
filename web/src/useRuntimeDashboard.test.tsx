import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState, SessionsResponse } from "./types";
import { useRuntimeDashboard } from "./useRuntimeDashboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("snapshot refresh lifecycle", () => {
  let requests: { url: string; signal?: AbortSignal | null; resolve: (response: Response) => void }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    requests = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => requests.push({ url: String(input), signal: init?.signal, resolve }))));
  });

  async function settle(start = 0, runtimeDir = "session-a", statuses: number[] = [200, 200, 200]) {
    await act(async () => {
      for (const [index, request] of requests.slice(start, start + 3).entries()) {
        const payload = request.url.startsWith("/api/state") ? stateFixture(runtimeDir)
          : request.url.startsWith("/api/runs") ? { runs: [{ runtimeDir, status: "running" }] }
            : { ...sessionsFixture(runtimeDir), sessions: [{ runtimeDir }] };
        request.resolve(new Response(JSON.stringify(statuses[index] === 200 ? payload : { error: "unavailable" }), { status: statuses[index] }));
      }
    });
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  function visibility(hidden: boolean) {
    act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  it("starts all three sources together and ignores every late response after synchronous pause", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    expect(requests).toHaveLength(3);
    act(() => result.current.setAutoRefresh(false));
    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    await settle();
    expect(result.current.data).toBeUndefined();
    expect(result.current.loadedRuntimeDir).toBeUndefined();
    expect(result.current.sessions).toEqual([]);
    expect(result.current.activeRuns).toEqual([]);
    expect(result.current.lastSuccessAt).toBeUndefined();
    await advance(30000);
    expect(requests).toHaveLength(3);
  });

  it("freezes a loaded snapshot and manually refreshes each source once while paused", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle();
    const previous = result.current.data;
    const successAt = result.current.lastSuccessAt;
    await advance(5000);
    act(() => result.current.setAutoRefresh(false));
    await settle(3, "late");
    expect(result.current.data).toBe(previous);
    expect(result.current.lastSuccessAt).toBe(successAt);
    let manual: Promise<void>;
    act(() => { manual = result.current.refresh(); });
    expect(requests).toHaveLength(9);
    await settle(6, "manual");
    await act(async () => { await manual; });
    expect(result.current.data?.runtimeDir).toBe("manual");
    expect(result.current.autoRefresh).toBe(false);
    await advance(30000);
    expect(requests).toHaveLength(9);
  });

  it("clears old runtime snapshots immediately and loads a new runtime even while paused", async () => {
    const { result, rerender } = renderHook(({ dir }) => useRuntimeDashboard(dir), { initialProps: { dir: "session-a" } });
    await settle();
    await advance(5000);
    act(() => result.current.setAutoRefresh(false));
    rerender({ dir: "session-b" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loadedRuntimeDir).toBeUndefined();
    expect(result.current.sessions).toEqual([]);
    expect(result.current.activeRuns).toEqual([]);
    await settle(6, "session-b");
    await settle(3, "session-a");
    expect(result.current.data?.runtimeDir).toBe("session-b");
    expect(result.current.activeRuns[0]?.runtimeDir).toBe("session-b");
    expect(result.current.sessions[0]?.runtimeDir).toBe("session-b");
    expect(result.current.autoRefresh).toBe(false);
  });

  it("resumes immediately after failure and waits five seconds after all sources settle", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle(0, "session-a", [500, 200, 200]);
    expect(result.current.runsKnown).toBe(true);
    expect(result.current.activeRuns).toHaveLength(1);
    act(() => result.current.setAutoRefresh(false));
    act(() => result.current.setAutoRefresh(true));
    expect(requests).toHaveLength(6);
    await advance(10000);
    expect(requests).toHaveLength(6);
    await settle(3);
    await advance(4999);
    expect(requests).toHaveLength(6);
    await advance(1);
    expect(requests).toHaveLength(9);
  });

  it("resets the next poll after a manual refresh and waits for slow sessions", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle();
    await advance(4000);
    act(() => { void result.current.refresh(); });
    await act(async () => {
      requests[3].resolve(new Response(JSON.stringify(stateFixture("session-a")), { status: 200 }));
      requests[4].resolve(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    });
    await advance(10000);
    expect(requests).toHaveLength(6);
    await act(async () => requests[5].resolve(new Response(JSON.stringify(sessionsFixture("session-a")), { status: 200 })));
    await advance(4999);
    expect(requests).toHaveLength(6);
    await advance(1);
    expect(requests).toHaveLength(9);
  });

  it("retains successful state and its timestamp after a same-runtime server failure", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle();
    const previous = result.current.data;
    const successAt = result.current.lastSuccessAt;
    await advance(5000);
    await settle(3, "session-a", [500, 200, 200]);
    expect(result.current.data).toBe(previous);
    expect(result.current.loadedRuntimeDir).toBe("session-a");
    expect(result.current.lastSuccessAt).toBe(successAt);
    expect(result.current.error).toBeTruthy();
    await advance(5000);
    expect(requests).toHaveLength(9);
  });

  it("loads a runtime chosen while hidden on visibility without resuming automatic refresh", async () => {
    const { result, rerender } = renderHook(({ dir }) => useRuntimeDashboard(dir), { initialProps: { dir: "session-a" } });
    await settle();
    act(() => result.current.setAutoRefresh(false));
    visibility(true);
    rerender({ dir: "session-b" });
    expect(requests).toHaveLength(3);
    visibility(false);
    expect(requests).toHaveLength(6);
    await settle(3, "session-b");
    expect(result.current.data?.runtimeDir).toBe("session-b");
    expect(result.current.autoRefresh).toBe(false);
    await advance(30000);
    expect(requests).toHaveLength(6);
  });

  it.each([false, true])("retries an interrupted paused runtime baseline after visibility returns (selected hidden: %s)", async (selectedHidden) => {
    const { result, rerender } = renderHook(({ dir }) => useRuntimeDashboard(dir), { initialProps: { dir: "session-a" } });
    await settle();
    act(() => result.current.setAutoRefresh(false));
    if (selectedHidden) visibility(true);
    rerender({ dir: "session-b" });
    if (selectedHidden) visibility(false);
    expect(requests).toHaveLength(6);
    await act(async () => requests[3].resolve(new Response(JSON.stringify(stateFixture("session-b")), { status: 200 })));
    visibility(true);
    expect(requests.slice(3).every((request) => request.signal?.aborted)).toBe(true);
    await settle(3, "stale-b");
    expect(result.current.data).toBeUndefined();
    visibility(false);
    expect(requests).toHaveLength(9);
    await settle(6, "session-b");
    expect(result.current.data?.runtimeDir).toBe("session-b");
    expect(result.current.loadedRuntimeDir).toBe("session-b");
    expect(result.current.autoRefresh).toBe(false);
    visibility(true);
    visibility(false);
    await advance(30000);
    expect(requests).toHaveLength(9);
  });

  it("does not restart a paused manual refresh interrupted by hiding", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle();
    const previous = result.current.data;
    act(() => result.current.setAutoRefresh(false));
    act(() => { void result.current.refresh(); });
    visibility(true);
    await settle(3, "late-manual");
    visibility(false);
    await advance(30000);
    expect(requests).toHaveLength(6);
    expect(result.current.data).toBe(previous);
    expect(result.current.autoRefresh).toBe(false);
  });

  it("disposes StrictMode generations, listeners and timers on unmount", async () => {
    const { result, unmount } = renderHook(() => useRuntimeDashboard("session-a"), { wrapper: StrictMode });
    expect(requests).toHaveLength(6);
    expect(requests.slice(0, 3).every((request) => request.signal?.aborted)).toBe(true);
    await settle(3);
    await settle(0, "stale");
    expect(result.current.data?.runtimeDir).toBe("session-a");
    unmount();
    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    visibility(true);
    visibility(false);
    await advance(30000);
    expect(requests).toHaveLength(6);
  });

  it("marks failed runs unknown instead of preserving stale active runs", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle();
    expect(result.current.runsKnown).toBe(true);
    await advance(5000);
    await settle(3, "session-a", [200, 500, 200]);
    expect(result.current.runsKnown).toBe(false);
    expect(result.current.activeRuns).toEqual([]);
    expect(result.current.data).toBeDefined();
  });

  it("cancels hidden work, ignores late results and fetches a new foreground baseline", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    visibility(true);
    expect(result.current.visible).toBe(false);
    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    await settle();
    expect(result.current.data).toBeUndefined();
    await advance(30000);
    expect(requests).toHaveLength(3);
    visibility(false);
    expect(requests).toHaveLength(6);
    await settle(3);
    expect(result.current.visible).toBe(true);
    expect(result.current.data).toBeDefined();
  });

  it("does not fetch in an initially hidden tab or resume a manually paused tab", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await advance(30000);
    expect(requests).toHaveLength(0);
    visibility(false);
    expect(requests).toHaveLength(3);
    act(() => result.current.setAutoRefresh(false));
    visibility(true);
    visibility(false);
    expect(requests).toHaveLength(3);
  });

  it("only marks a response delayed after twenty active foreground seconds", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await advance(20000);
    expect(result.current.delayed).toBe(false);
    await advance(1);
    expect(result.current.delayed).toBe(true);
    visibility(true);
    expect(result.current.delayed).toBe(false);
    await advance(60000);
    visibility(false);
    await advance(20000);
    expect(result.current.delayed).toBe(false);
    await advance(1);
    expect(result.current.delayed).toBe(true);
    act(() => result.current.setAutoRefresh(false));
    await advance(60000);
    expect(result.current.delayed).toBe(false);
    act(() => result.current.setAutoRefresh(true));
    await advance(20000);
    expect(result.current.delayed).toBe(false);
    await settle(6);
    expect(result.current.lastSuccessAt).toBe(Date.now());
    expect(result.current.data?.loadedAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it.each([0, 1, 2])("clears business data when source %i returns unauthorized", async (source) => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle();
    await advance(5000);
    const statuses = [200, 200, 200];
    statuses[source] = 401;
    await settle(3, "session-a", statuses);
    expect(result.current.data).toBeUndefined();
    expect(result.current.sessions).toEqual([]);
    expect(result.current.activeRuns).toEqual([]);
    expect(result.current.lastSuccessAt).toBeUndefined();
    await advance(30000);
    expect(requests).toHaveLength(6);
  });

  it("stops automatic retries after forbidden responses but permits a manual retry", async () => {
    const { result } = renderHook(() => useRuntimeDashboard("session-a"));
    await settle(0, "session-a", [403, 200, 200]);
    expect(result.current.autoRefresh).toBe(false);
    await advance(30000);
    expect(requests).toHaveLength(3);
    act(() => { void result.current.refresh(); });
    await settle(3);
    expect(result.current.data).toBeDefined();
  });
});

describe("useRuntimeDashboard", () => {
  it("loads fresh state when the runtime directory changes", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const runtimeDir = url.includes("session-b") ? "session-b" : "session-a";
      const payload = url.startsWith("/api/state") ? stateFixture(runtimeDir) : sessionsFixture(runtimeDir);
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }));

    const { result, rerender } = renderHook(({ runtimeDir }) => useRuntimeDashboard(runtimeDir), {
      initialProps: { runtimeDir: "session-a" }
    });
    await waitFor(() => expect(result.current.data?.runtimeDir).toBe("session-a"));
    rerender({ runtimeDir: "session-b" });
    await waitFor(() => expect(result.current.data?.runtimeDir).toBe("session-b"));
  });

  it("tracks the requested runtimeDir even when the server returns a canonical absolute path", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      // The real server resolves runtimeDir to a canonical absolute path.
      const payload = url.startsWith("/api/state")
        ? stateFixture("/absolute/canonical/.agent-runtime/sessions/session-a")
        : sessionsFixture("session-a");
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }));

    const { result } = renderHook(() => useRuntimeDashboard(".agent-runtime/sessions/session-a"));
    await waitFor(() => expect(result.current.data?.runtimeDir).toBe("/absolute/canonical/.agent-runtime/sessions/session-a"));
    expect(result.current.loadedRuntimeDir).toBe(".agent-runtime/sessions/session-a");
  });

  it("aborts in-flight requests when the hook unmounts", () => {
    const aborted = vi.fn();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", aborted);
      return new Promise<Response>(() => undefined);
    }));
    const { unmount } = renderHook(() => useRuntimeDashboard("session-a"));
    unmount();
    expect(aborted).toHaveBeenCalled();
  });

  it("polls every five seconds while auto refresh is enabled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const payload = String(input).startsWith("/api/state") ? stateFixture("session-a") : sessionsFixture("session-a");
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useRuntimeDashboard("session-a"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

function stateFixture(runtimeDir: string): RuntimeState {
  return {
    runtimeDir,
    loadedAt: "2026-07-11T00:00:00.000Z",
    overview: {
      graph: { nodeCount: 0, edgeCount: 0, byKind: {}, byType: {} },
      events: { count: 0, byRole: {}, byType: {} },
      tasks: { count: 0, byStatus: {}, items: [] },
      artifacts: { count: 0, totalBytes: 0 },
      agents: {}
    },
    traceItems: [],
    reports: { taskOutcomes: [], epochOutcomes: [], planningRounds: [] },
    graph: { nodes: [], edges: [], source: "sqlite", summary: {} },
    events: [],
    artifacts: { records: [], summary: { count: 0, totalBytes: 0 } }
  };
}

function sessionsFixture(runtimeDir: string): SessionsResponse {
  return {
    rootDir: runtimeDir,
    loadedAt: "2026-07-11T00:00:00.000Z",
    sessions: [],
    summary: { count: 0, totalTasks: 0, totalEvents: 0 }
  };
}
