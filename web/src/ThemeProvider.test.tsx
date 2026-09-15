import { fireEvent, render, screen } from "@testing-library/react";
import { theme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixedDarkTheme, ThemeProvider, useTheme } from "./ThemeProvider";
import { Brand } from "./components/Brand";
import { LanguageProvider, useLanguage } from "./language";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

function Probe() {
  const { mode, toggleTheme } = useTheme();
  const { locale, toggleLocale } = useLanguage();
  const { token } = theme.useToken();
  return <>
    <button onClick={toggleTheme}>{mode}</button>
    <button onClick={toggleLocale}>{locale}</button>
    <output aria-label="Surface color">{token.colorBgContainer}</output>
    <Brand />
  </>;
}

function renderTheme() {
  return render(<ThemeProvider><LanguageProvider><Probe /></LanguageProvider></ThemeProvider>);
}

describe("ThemeProvider", () => {
  it("keeps wallboard surfaces transparent without overwriting the workbench theme", () => {
    localStorage.setItem("qingxuan-theme", "light");
    render(<ThemeProvider><LanguageProvider><FixedDarkTheme><Probe /></FixedDarkTheme></LanguageProvider></ThemeProvider>);
    expect(screen.getByLabelText("Surface color")).toHaveTextContent("transparent");
    expect(screen.getByRole("button", { name: "dark" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("qingxuan-theme")).toBe("light");
  });

  it("defaults to dark and carries the AntD theme through the locale provider", () => {
    renderTheme();
    expect(screen.getByRole("button", { name: "dark" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByLabelText("Surface color")).toHaveTextContent("#1c1f22");
  });

  it("restores a stored light preference", () => {
    localStorage.setItem("qingxuan-theme", "light");
    renderTheme();
    expect(screen.getByRole("button", { name: "light" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByLabelText("Surface color")).toHaveTextContent("#ffffff");
  });

  it("persists both theme transitions and restores the preference after remount", () => {
    const view = renderTheme();
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(localStorage.getItem("qingxuan-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    view.unmount();
    renderTheme();
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(localStorage.getItem("qingxuan-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores an invalid stored theme", () => {
    localStorage.setItem("qingxuan-theme", "invalid");
    renderTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("shows the accessible Qingxuan brand and the matching symbol in both themes", () => {
    localStorage.setItem("luanniao-locale", "zh-CN");
    renderTheme();
    const brand = screen.getByRole("img", { name: "青玄 Qingxuan" });
    expect(brand.querySelector("img")).toHaveAttribute("src", "/brand/qingxuan-symbol-on-dark-128.png");
    expect(screen.getByText("青玄")).toBeInTheDocument();
    expect(screen.getByText("自动渗透agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(brand.querySelector("img")).toHaveAttribute("src", "/brand/qingxuan-symbol-on-light-128.png");
  });

  it("keeps the Chinese brand with an English subtitle for the English locale", () => {
    localStorage.setItem("luanniao-locale", "en-US");
    renderTheme();
    expect(screen.getByText("青玄")).toBeInTheDocument();
    expect(screen.getByText("Autonomous Pentest Agent")).toBeInTheDocument();
  });

  it("can switch in memory when browser storage is unavailable", () => {
    const get = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    const set = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    try {
      renderTheme();
      fireEvent.click(screen.getByRole("button", { name: "dark" }));
      expect(document.documentElement.dataset.theme).toBe("light");
      const initialLocale = navigator.language.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
      fireEvent.click(screen.getByRole("button", { name: initialLocale }));
      expect(document.documentElement.lang).toBe(initialLocale === "en-US" ? "zh-CN" : "en-US");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
