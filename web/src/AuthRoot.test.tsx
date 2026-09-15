import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "./types";
import { AuthRoot } from "./AuthRoot";
import { LanguageProvider } from "./language";

const { auth, mountedApp } = vi.hoisted(() => ({
  auth: { user: undefined as AuthUser | undefined, loading: false, submitting: false, error: undefined as string | undefined, login: vi.fn(), register: vi.fn(), logout: vi.fn(), clearError: vi.fn() },
  mountedApp: vi.fn()
}));
vi.mock("./useAuth", () => ({ useAuth: () => auth }));
vi.mock("./App", () => ({ default: ({ onHome }: { onHome?: () => void }) => {
  mountedApp();
  return <div data-testid="business-app"><button onClick={onHome}>Return home</button></div>;
} }));
const user: AuthUser = { id: "test-user", username: "analyst", displayName: "Analyst", role: "analyst", createdAt: "2026-09-15T00:00:00Z" };
const root = () => <LanguageProvider><AuthRoot /></LanguageProvider>;

describe("homepage and login entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(auth, { user: undefined, loading: false, submitting: false, error: undefined });
    localStorage.clear();
    localStorage.setItem("luanniao-locale", "zh-CN");
    window.history.replaceState({}, "", "/");
  });

  it("renders the public homepage while session lookup is still pending", () => {
    auth.loading = true;
    render(root());
    expect(screen.getByRole("heading", { level: 1, name: "青玄" })).toBeInTheDocument();
    expect(mountedApp).not.toHaveBeenCalled();
  });

  it("protects a deep link and restores its destination after login", async () => {
    window.history.replaceState({}, "", "/?view=wallboard&runtimeDir=demo&wallGraph=task&nodeId=task%3A1");
    const view = render(root());
    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
    expect(mountedApp).not.toHaveBeenCalled();
    await waitFor(() => expect(new URLSearchParams(location.search).get("page")).toBe("login"));
    auth.user = user;
    view.rerender(root());
    await screen.findByTestId("business-app");
    expect(Object.fromEntries(new URLSearchParams(location.search))).toEqual({ runtimeDir: "demo", view: "wallboard", nodeId: "task:1", wallGraph: "task" });
  });

  it("returns to the public home without signing out and handles browser navigation", async () => {
    auth.user = user;
    window.history.replaceState({}, "", "/?view=overview");
    render(root());
    await screen.findByTestId("business-app");
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    expect(screen.getByRole("heading", { level: 1, name: "青玄" })).toBeInTheDocument();
    expect(auth.logout).not.toHaveBeenCalled();
    act(() => {
      window.history.replaceState({}, "", "/?view=overview");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByTestId("business-app");
  });

  it("uses the latest workbench URL when a session expires", async () => {
    auth.user = user;
    window.history.replaceState({}, "", "/?view=overview");
    const view = render(root());
    await screen.findByTestId("business-app");
    window.history.pushState({}, "", "/?view=wallboard&runtimeDir=latest&wallGraph=reasoning");
    auth.user = undefined;
    view.rerender(root());
    await screen.findByLabelText("用户名");
    await waitFor(() => expect(new URLSearchParams(location.search).get("page")).toBe("login"));
    expect(new URLSearchParams(location.search).get("runtimeDir")).toBe("latest");
    expect(new URLSearchParams(location.search).get("wallGraph")).toBe("reasoning");
  });

  it("keeps login errors and input values without mounting the app", () => {
    window.history.replaceState({}, "", "/?page=login&view=wallboard");
    const view = render(root());
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "analyst" } });
    auth.error = "账号或密码错误";
    view.rerender(root());
    expect(screen.getByRole("alert")).toHaveTextContent("账号或密码错误");
    expect(screen.getByLabelText("用户名")).toHaveValue("analyst");
    expect(new URLSearchParams(location.search).get("view")).toBe("wallboard");
    expect(mountedApp).not.toHaveBeenCalled();
  });
});
