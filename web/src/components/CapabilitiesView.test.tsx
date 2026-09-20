import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesView } from "./CapabilitiesView";
import { fetchMcpServers, fetchSkills, fetchSpecialists } from "../api";
import type { AuthUser } from "../types";

vi.mock("../api", () => ({
  fetchSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  fetchMcpServers: vi.fn(),
  setMcpEnabled: vi.fn(),
  fetchEnvConfig: vi.fn(),
  updateEnvConfig: vi.fn(),
  fetchSpecialists: vi.fn(),
  setSpecialistEnabled: vi.fn(),
  updateSpecialistOptions: vi.fn(),
  setSpecialistOptionsMode: vi.fn()
}));

const admin: AuthUser = { id: "admin-1", username: "admin", displayName: "Admin", role: "admin", createdAt: "2026-09-16T00:00:00.000Z" };

describe("CapabilitiesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchSkills).mockResolvedValue({
      scannedAt: "2026-09-16T00:00:00.000Z",
      diagnostics: [],
      skills: [{
        name: "recon-subdomain",
        description: "Enumerate subdomains",
        filePath: "/skills/recon-subdomain/SKILL.md",
        baseDir: "/skills/recon-subdomain",
        valid: true,
        enabled: true,
        modelInvocable: true
      }]
    });
    vi.mocked(fetchMcpServers).mockResolvedValue({
      scannedAt: "2026-09-16T00:00:00.000Z",
      diagnostics: [],
      servers: [{ name: "credential", description: "Built-in credential store", tools: ["credential_query"], configured: true, enabled: true }]
    });
    vi.mocked(fetchSpecialists).mockResolvedValue({
      scannedAt: "2026-09-16T00:00:00.000Z",
      diagnostics: [],
      specialists: [{
        id: "bruteforce",
        name: "爆破 Agent",
        description: "口令猜测",
        source: "builtin",
        enabled: true,
        valid: true,
        introspected: true,
        executability: "prompt-only",
        promptMode: "extend",
        enabledGroups: ["sandbox"],
        disabledGroups: ["fofa"],
        deniedTools: [],
        skillMode: "allowlist",
        budget: { defaultMaxTurns: 16, maxTurnsCeiling: 24, epochTurnSlice: 12, epochTimeShare: 0.7 },
        optionsMode: "planner",
        authorOptionsMode: "planner",
        options: [],
        diagnostics: []
      }]
    });
  });

  afterEach(cleanup);

  it("renders all three capability tabs and switches between them", async () => {
    render(<CapabilitiesView user={admin} tab="skills" onTabChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Skill" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "MCP" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "专精 Agent" })).toBeInTheDocument();
    expect(await screen.findByText("recon-subdomain")).toBeInTheDocument();
  });

  it("mounts the requested tab and reports tab changes", async () => {
    const onTabChange = vi.fn();
    render(<CapabilitiesView user={admin} tab="agents" onTabChange={onTabChange} />);
    expect(await screen.findByText("bruteforce")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(onTabChange).toHaveBeenCalledWith("mcp");
  });

  it("keeps skills visible when runtime state is unavailable", async () => {
    render(<CapabilitiesView user={admin} tab="skills" onTabChange={vi.fn()} />);
    await waitFor(() => expect(fetchSkills).toHaveBeenCalled());
    expect(await screen.findByText("1 个 Skill")).toBeInTheDocument();
  });
});
