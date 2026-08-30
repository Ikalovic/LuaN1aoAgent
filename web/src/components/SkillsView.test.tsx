import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSkills, setSkillEnabled } from "../api";
import type { AuthUser, SkillRegistrySnapshot } from "../types";
import { SkillsView } from "./SkillsView";

vi.mock("../api", () => ({
  fetchSkills: vi.fn(),
  setSkillEnabled: vi.fn()
}));

const admin: AuthUser = {
  id: "admin-1",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  createdAt: "2026-08-30T00:00:00.000Z"
};
const analyst: AuthUser = { ...admin, id: "analyst-1", username: "analyst", role: "analyst" };
const snapshot: SkillRegistrySnapshot = {
  scannedAt: "2026-08-30T00:00:00.000Z",
  skills: [
    {
      name: "recon-subdomain",
      description: "Enumerate authorized subdomains",
      filePath: "/project/.agents/skills/recon-subdomain/SKILL.md",
      baseDir: "/project/.agents/skills/recon-subdomain",
      valid: true,
      enabled: true,
      modelInvocable: true
    },
    {
      name: "ctf-web",
      description: "Solve authorized Web CTF challenges",
      filePath: "/project/.agents/skills/ctf-web/SKILL.md",
      baseDir: "/project/.agents/skills/ctf-web",
      valid: true,
      enabled: false,
      modelInvocable: true
    }
  ],
  diagnostics: [{ code: "skill_warning", message: "Example registry warning", skillName: "ctf-web" }]
};

const mockedFetch = vi.mocked(fetchSkills);
const mockedSetEnabled = vi.mocked(setSkillEnabled);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(snapshot);
});

describe("SkillsView", () => {
  it("loads registry summary and filters skills", async () => {
    render(<SkillsView user={admin} />);

    await screen.findByText("recon-subdomain");
    expect(screen.getByText("2 个 Skill")).toBeInTheDocument();
    expect(screen.getByText("1 个已启用")).toBeInTheDocument();
    expect(screen.getByText("Example registry warning")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索名称或描述"), { target: { value: "ctf" } });
    expect(screen.getByText("ctf-web")).toBeInTheDocument();
    expect(screen.queryByText("recon-subdomain")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索名称或描述"), { target: { value: "" } });
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Skill 状态" }));
    fireEvent.click(await screen.findByText("已停用"));
    expect(screen.getByText("ctf-web")).toBeInTheDocument();
    expect(screen.queryByText("recon-subdomain")).not.toBeInTheDocument();
  });

  it("lets administrators toggle one valid skill", async () => {
    const disabled = { ...snapshot.skills[0], enabled: false };
    mockedFetch
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, skills: [disabled, snapshot.skills[1]] });
    mockedSetEnabled.mockResolvedValue(disabled);
    render(<SkillsView user={admin} />);

    fireEvent.click(await screen.findByRole("switch", { name: "recon-subdomain" }));

    await waitFor(() => expect(mockedSetEnabled).toHaveBeenCalledWith("recon-subdomain", false));
    await waitFor(() => expect(screen.getByRole("switch", { name: "recon-subdomain" })).not.toBeChecked());
  });

  it("keeps analyst and invalid skill switches read-only", async () => {
    const invalidSnapshot = {
      ...snapshot,
      skills: [snapshot.skills[0], { ...snapshot.skills[1], valid: false }]
    };
    mockedFetch.mockResolvedValue(invalidSnapshot);
    const { rerender } = render(<SkillsView user={analyst} />);

    expect(await screen.findByRole("switch", { name: "recon-subdomain" })).toBeDisabled();

    rerender(<SkillsView user={admin} />);
    expect(screen.getByRole("switch", { name: "ctf-web" })).toBeDisabled();
    expect(mockedSetEnabled).not.toHaveBeenCalled();
  });

  it("shows a retryable load failure", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("registry unavailable"));
    render(<SkillsView user={admin} />);

    expect(await screen.findByText("registry unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重\s*试/ }));
    expect(await screen.findByText("recon-subdomain")).toBeInTheDocument();
  });

  it("keeps the prior state when a mutation fails", async () => {
    mockedSetEnabled.mockRejectedValueOnce(new Error("update rejected"));
    render(<SkillsView user={admin} />);
    const toggle = await screen.findByRole("switch", { name: "recon-subdomain" });

    fireEvent.click(toggle);

    expect(await screen.findByText("update rejected")).toBeInTheDocument();
    expect(toggle).toBeChecked();
  });
});
