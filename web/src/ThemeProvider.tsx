import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConfigProvider } from "antd";
import { getAppTheme, themeColors, THEME_STORAGE_KEY, type ThemeMode } from "./theme";

interface ThemeContextValue {
  mode: ThemeMode;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ mode: "dark", toggleTheme: () => undefined });

function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readStoredTheme);
  const toggleTheme = useCallback(() => setMode((current) => current === "dark" ? "light" : "dark"), []);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[mode].background);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Theme changes remain available when browser storage is blocked.
    }
  }, [mode]);

  const value = useMemo(() => ({ mode, toggleTheme }), [mode, toggleTheme]);
  const config = useMemo(() => getAppTheme(mode), [mode]);
  return <ThemeContext.Provider value={value}><ConfigProvider theme={config}>{children}</ConfigProvider></ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function FixedDarkTheme({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({ mode: "dark" as const, toggleTheme: () => undefined }), []);
  const config = useMemo(() => {
    const base = getAppTheme("dark");
    return {
      ...base,
      token: { ...base.token, colorBgContainer: "transparent", colorBgElevated: "#14232a", colorBorder: "#557d8580", borderRadius: 2 },
      components: {
        ...base.components,
        Button: { defaultBg: "transparent", defaultHoverBg: "#83e6d40d", defaultActiveBg: "#83e6d417", defaultColor: "#c6e2e8", defaultBorderColor: "#557d8580", controlHeight: 36 },
        Select: { selectorBg: "transparent", optionSelectedBg: "#214047", activeBorderColor: "#82e1d4", controlHeight: 36 },
        Input: { activeBg: "transparent", hoverBg: "transparent", controlHeight: 36 },
        Segmented: { trackBg: "transparent", itemSelectedBg: "transparent", itemSelectedColor: "#a5f6e2", itemColor: "#9ab6c2", itemHoverBg: "#83e6d40d" }
      }
    };
  }, []);
  return <ThemeContext.Provider value={value}><ConfigProvider theme={config} getPopupContainer={(trigger) => trigger?.closest<HTMLElement>(".wallboard") ?? document.body}>{children}</ConfigProvider></ThemeContext.Provider>;
}
