import { describe, expect, it } from "vitest";
import { parseNavigation, navigationUrl, transitionNavigation } from "./navigation";

describe("workbench navigation", () => {
  it("supports new backend views and remote capabilities deep links", () => {
    for (const view of ["agents", "memory"]) expect(parseNavigation(`?view=${view}`, () => null).view).toBe(view);
    for (const tab of ["skills", "mcp", "agents"]) {
      expect(parseNavigation(`?view=capabilities&tab=${tab}`, () => null).view).toBe(tab);
    }
    expect(parseNavigation("?view=capabilities&tab=invalid", () => null).view).toBe("skills");
  });
  it("defaults to overview and preserves legacy routes and opaque flow IDs", () => {
    expect(parseNavigation("", () => null).view).toBe("overview");
    expect(parseNavigation("?view=traffic&exchangeId=flow%3Aa%2Fb%2B1", () => null).exchangeId).toBe("flow:a/b+1");
    expect(parseNavigation("?view=operation", () => { throw Error(); }).view).toBe("operation");
    expect(parseNavigation("?view=credentials&runtimeDir=runtime-a", () => null)).toMatchObject({ view: "credentials", runtimeDir: "runtime-a" });
  });
  it("whitelists safe state and canonical UTC ranges", () => {
    const state = parseNavigation("?view=trace&query=secret&role=evil&range=custom&from=2026-09-15T08:00:00%2B08:00&to=2026-09-15T01:00:00Z", () => null);
    expect(navigationUrl(state)).not.toMatch(/query|secret|evil/);
    expect(state.from).toBe("2026-09-15T00:00:00.000Z");
  });
  it("preserves the environment management route", () => {
    const state = parseNavigation("?view=env", () => null);
    expect(state.view).toBe("env");
    expect(navigationUrl(state)).toContain("view=env");
  });
  it("clears entity state immediately when switching runtime", () => {
    const state = parseNavigation("?runtimeDir=A&view=traffic&exchangeId=opaque&taskId=T", () => null);
    const next = transitionNavigation(state, { runtimeDir: "B" });
    expect(next.exchangeId).toBeUndefined();
    expect(next.taskId).toBeUndefined();
  });
});
