import { beforeEach, describe, expect, it } from "vitest";
import { appDestination, loginDestination, parseEntryPage } from "./entryNavigation";

describe("public entry navigation", () => {
  beforeEach(() => localStorage.clear());

  it("separates public pages from legacy business links", () => {
    expect(parseEntryPage("")).toBe("home");
    expect(parseEntryPage("?page=home&view=wallboard")).toBe("home");
    expect(parseEntryPage("?page=login")).toBe("login");
    expect(parseEntryPage("?view=overview")).toBe("app");
    expect(parseEntryPage("?runtimeDir=demo")).toBe("app");
  });

  it("preserves safe deep-link state across login without external redirects", () => {
    const params = new URLSearchParams(loginDestination("?view=wallboard&runtimeDir=demo&wallGraph=task&nodeId=task%3A1&returnTo=https://outside.example&password=secret"));
    expect(Object.fromEntries(params)).toEqual({ runtimeDir: "demo", view: "wallboard", nodeId: "task:1", wallGraph: "task", page: "login" });
    expect(new URLSearchParams(appDestination("?" + params)).has("page")).toBe(false);
    expect(new URLSearchParams(appDestination("?view=https://outside.example")).get("view")).toBe("overview");
  });

  it("uses the remembered runtime when entering from the homepage", () => {
    localStorage.setItem("luanniao-runtime-dir", "remembered-run");
    expect(new URLSearchParams(appDestination("?view=overview")).get("runtimeDir")).toBe("remembered-run");
  });
});
