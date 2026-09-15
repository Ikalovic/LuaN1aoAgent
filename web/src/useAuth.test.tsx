import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./useAuth";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAuth", () => {
  it("clears the current user on session expiry without changing navigation or form errors", async () => {
    const user = { id: "user:1", username: "analyst" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify(
      String(input).endsWith("/me") ? { user } : String(input).endsWith("/csrf") ? { csrfToken: "test" } : { error: "bad password" }
    ), { status: String(input).endsWith("/login") ? 401 : 200 }))));
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.user).toEqual(user));
    await act(async () => { await result.current.login({ username: "analyst", password: "wrong" }).catch(() => undefined); });
    const location = window.location.href;
    act(() => window.dispatchEvent(new Event("qingxuan:unauthorized")));
    expect(result.current.user).toBeUndefined();
    expect(result.current.error).toBe("bad password");
    expect(window.location.href).toBe(location);
  });

  it("ignores a late current-user response after session expiry", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const { result } = renderHook(() => useAuth());
    act(() => window.dispatchEvent(new Event("qingxuan:unauthorized")));
    await act(async () => resolve(new Response(JSON.stringify({ user: { id: "stale" } }), { status: 200 })));
    expect(result.current.user).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it("moves from an unauthorized gate into an authenticated session and logs out", async () => {
    const user = {
      id: "user:1",
      username: "analyst",
      displayName: "安全分析员",
      role: "analyst",
      createdAt: "2026-07-11T00:00:00.000Z"
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/me")) {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: "unauthorized", message: "请先登录" } }), { status: 401 }));
      }
      if (url.endsWith("/csrf")) {
        return Promise.resolve(new Response(JSON.stringify({ csrfToken: "csrf-token" }), { status: 200 }));
      }
      if (url.endsWith("/login")) {
        return Promise.resolve(new Response(JSON.stringify({ user }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeUndefined();

    await act(async () => result.current.login({ username: "analyst", password: "secure-pass-123" }));
    expect(result.current.user).toEqual(user);

    await act(async () => result.current.logout());
    expect(result.current.user).toBeUndefined();
  });
});
