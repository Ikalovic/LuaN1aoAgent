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
});
