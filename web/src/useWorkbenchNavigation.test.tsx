import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchNavigation } from "./useWorkbenchNavigation";
describe("navigation history", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/?runtimeDir=A&view=overview"); localStorage.clear(); });
  it("adds exactly one entry per navigation under StrictMode", () => {
    const push = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useWorkbenchNavigation(), { wrapper: StrictMode });
    act(() => result.current.navigate({ view: "operation" }));
    act(() => result.current.navigate({ view: "trace" }));
    expect(push).toHaveBeenCalledTimes(2);
    push.mockRestore();
  });
  it("restores runtime, range, and opaque selection on popstate", () => {
    const { result } = renderHook(() => useWorkbenchNavigation());
    act(() => {
      window.history.replaceState({}, "", "/?runtimeDir=B&view=traffic&exchangeId=a%2Fb%3Ac&range=1h");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.state).toMatchObject({ runtimeDir: "B", view: "traffic", exchangeId: "a/b:c", range: "1h" });
  });
});
