import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { LanguageProvider } from "./language";
import type { AuthUser } from "./types";

vi.mock("./useRuntimeDashboard", () => ({
  useRuntimeDashboard: () => ({
    data: undefined,
    loadedRuntimeDir: undefined,
    sessions: [],
    activeRuns: [],
    loading: true,
    refreshing: false,
    error: "runtime unavailable",
    autoRefresh: false,
    setAutoRefresh: vi.fn(),
    refresh: vi.fn()
  })
}));

vi.mock("./components/ResizableWorkspace", () => ({
  ResizableWorkspace: ({ sidebar, main, inspector }: { sidebar: React.ReactNode; main: React.ReactNode; inspector: React.ReactNode }) => (
    <div>{sidebar}{main}{inspector}</div>
  )
}));

vi.mock("./components/SkillsView", () => ({
  SkillsView: () => <div>skill registry content</div>
}));

vi.mock("./components/CredentialsView", () => ({
  CredentialsView: ({ runtimeDir }: { runtimeDir: string }) => <div>credentials for {runtimeDir}</div>
}));

const admin: AuthUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-08-30T00:00:00.000Z"
};

describe("App Skills route", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("luanniao-locale", "en-US");
    window.history.replaceState({}, "", "/?view=skills");
  });

  it("renders Skills independently when runtime loading fails", () => {
    render(<LanguageProvider><App user={admin} onLogout={vi.fn()} /></LanguageProvider>);

    expect(screen.getByText("skill registry content")).toBeInTheDocument();
  });

  it("defaults to overview with unavailable metrics and contextual detail only", () => {
    window.history.replaceState({}, "", "/");
    render(<LanguageProvider><App user={{ ...admin, role: "analyst" }} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole("navigation", { name: "Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hosts/ })).toHaveTextContent("--");
    expect(screen.queryByText("INSPECTOR")).not.toBeInTheDocument();
  });
  it("does not mount approvals for an analyst direct URL", () => {
    window.history.replaceState({}, "", "/?view=approvals");
    render(<LanguageProvider><App user={{ ...admin, role: "analyst" }} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  });

  it("keeps the upstream credentials route and administrator navigation", () => {
    window.history.replaceState({}, "", "/?view=credentials&runtimeDir=runtime-a");
    render(<LanguageProvider><App user={admin} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("credentials for runtime-a")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Credentials", selected: true })).toBeInTheDocument();
  });

  it("does not expose credential management to an analyst", () => {
    window.history.replaceState({}, "", "/?view=credentials&runtimeDir=runtime-a");
    render(<LanguageProvider><App user={{ ...admin, role: "analyst" }} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("Administrator access required")).toBeInTheDocument();
    expect(screen.queryByText("credentials for runtime-a")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Credentials" })).not.toBeInTheDocument();
  });
});
