import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { LanguageProvider } from "./language";
import type { AuthUser } from "./types";
import { fetchEnvConfig } from "./api";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  fetchApprovals: vi.fn().mockResolvedValue({ approvals: [] }),
  fetchEnvConfig: vi.fn().mockResolvedValue({ path: "/project/.env", entries: [{ key: "FOFA_EMAIL", sensitive: false, value: "ops@example.com" }] }),
  updateEnvConfig: vi.fn()
}));

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

vi.mock("./components/GraphView", () => ({ GraphView: () => <div>graph content</div> }));
vi.mock("./components/AgentsPanel", () => ({ AgentsPanel: ({ user }: { user: AuthUser }) => <div>specialists for {user.role}</div> }));
vi.mock("./components/MemoryView", () => ({ MemoryView: ({ runtimeDir }: { runtimeDir: string }) => <div>memory for {runtimeDir}</div> }));

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
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("luanniao-locale", "en-US");
    window.history.replaceState({}, "", "/?view=skills");
  });

  it("renders Skills independently when runtime loading fails", () => {
    render(<LanguageProvider><App user={admin} onLogout={vi.fn()} /></LanguageProvider>);

    expect(screen.getByText("skill registry content")).toBeInTheDocument();
  });
  it("exposes specialist management independently of runtime data for both roles", () => {
    window.history.replaceState({}, "", "/?view=agents");
    render(<LanguageProvider><App user={{ ...admin, role: "analyst" }} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("specialists for analyst")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agents", selected: true })).toBeInTheDocument();
    expect(screen.queryByText("runtime unavailable")).not.toBeInTheDocument();
  });
  it("connects graph memory to the active runtime and assets navigation", () => {
    window.history.replaceState({}, "", "/?view=memory&runtimeDir=runtime-memory");
    render(<LanguageProvider><App user={admin} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("memory for runtime-memory")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Graph memory", selected: true })).toBeInTheDocument();
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

  it("renders environment management independently of runtime availability", async () => {
    window.history.replaceState({}, "", "/?view=env");
    render(<LanguageProvider><App user={admin} onLogout={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText("FOFA_EMAIL")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Environment", selected: true })).toBeInTheDocument();
    expect(screen.queryByText("runtime unavailable")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not expose or fetch environment configuration for an analyst", () => {
    window.history.replaceState({}, "", "/?view=env");
    render(<LanguageProvider><App user={{ ...admin, role: "analyst" }} onLogout={vi.fn()} /></LanguageProvider>);
    expect(screen.getByText("Administrator access required")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Environment" })).not.toBeInTheDocument();
    expect(fetchEnvConfig).not.toHaveBeenCalled();
  });

  it("keeps an environment draft when navigation is cancelled", async () => {
    window.history.replaceState({}, "", "/?view=env");
    render(<LanguageProvider><App user={admin} onLogout={vi.fn()} /></LanguageProvider>);
    await screen.findByText("FOFA_EMAIL");
    fireEvent.change(screen.getByPlaceholderText("Name, e.g. FOFA_API_KEY"), { target: { value: "NEW_KEY" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
      expect(confirm).toHaveBeenCalledWith("Discard unsaved environment changes?");
      expect(screen.getByDisplayValue("NEW_KEY")).toBeInTheDocument();
      expect(window.location.search).toBe("?view=env");
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
      expect(screen.getByText("skill registry content")).toBeInTheDocument();
    } finally {
      confirm.mockRestore();
    }
  });
});
