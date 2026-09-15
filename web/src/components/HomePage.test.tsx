import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";

const entryProps = {
  authenticated: false,
  workbenchUrl: "/?view=overview",
  wallboardUrl: "/?view=wallboard",
  loginUrl: "/?view=login",
  onNavigate: vi.fn()
};

describe("HomePage", () => {
  it("shows the Qingxuan identity, upstream credit, and real entry URLs", () => {
    const { rerender } = render(<HomePage {...entryProps} />);

    expect(screen.getByRole("heading", { level: 1, name: "青玄" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入工作台" })).toHaveAttribute("href", entryProps.workbenchUrl);
    const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
    expect(navigation.getByRole("link", { name: "工作台" })).toHaveAttribute("href", entryProps.workbenchUrl);
    expect(navigation.getByRole("link", { name: "态势大屏" })).toHaveAttribute("href", entryProps.wallboardUrl);
    expect(navigation.getByRole("link", { name: "登录" })).toHaveAttribute("href", entryProps.loginUrl);
    const credit = screen.getByRole("contentinfo");
    expect(credit).toHaveTextContent("本项目基于 LuaN1aoAgent 改造而成。");
    expect(within(credit).getByRole("link", { name: "LuaN1aoAgent" })).toHaveAttribute("href", "https://github.com/SanMuzZzZz/LuaN1aoAgent");

    rerender(<HomePage {...entryProps} authenticated />);
    expect(navigation.queryByRole("link", { name: "登录" })).not.toBeInTheDocument();
    expect(navigation.getByRole("link", { name: "进入工作台" })).toHaveAttribute("href", entryProps.workbenchUrl);
  });

  it("switches the product screenshot with accessible tabs and keeps a usable image fallback", () => {
    render(<HomePage {...entryProps} />);
    const workbenchTab = screen.getByRole("tab", { name: "工作台" });
    const wallboardTab = screen.getByRole("tab", { name: "态势大屏" });
    expect(within(screen.getByRole("tabpanel")).getByRole("img")).toHaveAttribute("src", "/art/home-workbench.webp");
    expect(screen.getByText("产品界面截图，使用本地演示数据。")).toBeVisible();

    fireEvent.keyDown(workbenchTab, { key: "ArrowRight" });
    expect(wallboardTab).toHaveAttribute("aria-selected", "true");
    expect(wallboardTab).toHaveFocus();
    const wallboardImage = within(screen.getByRole("tabpanel")).getByRole("img");
    expect(wallboardImage).toHaveAttribute("src", "/art/home-wallboard.webp");

    fireEvent.error(wallboardImage);
    expect(within(screen.getByRole("tabpanel")).getByRole("link", { name: "态势大屏" })).toHaveAttribute("href", entryProps.wallboardUrl);
    expect(screen.getByText("产品界面截图，使用本地演示数据。")).toBeVisible();
    fireEvent.click(workbenchTab);
    expect(workbenchTab).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel")).getByRole("img")).toHaveAttribute("src", "/art/home-workbench.webp");
  });

  it("intercepts only unmodified primary clicks on app entries", () => {
    const onNavigate = vi.fn();
    render(<HomePage {...entryProps} onNavigate={onNavigate} />);
    const link = screen.getByRole("link", { name: "进入工作台" });
    const prevented: boolean[] = [];
    const click = (options: MouseEventInit) => {
      document.addEventListener("click", (event) => {
        prevented.push(event.defaultPrevented);
        event.preventDefault();
      }, { once: true });
      fireEvent.click(link, options);
    };

    click({ button: 0 });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(entryProps.workbenchUrl);
    onNavigate.mockClear();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      click(options);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    expect(prevented).toEqual([true, false, false, false, false, false]);
  });
});
