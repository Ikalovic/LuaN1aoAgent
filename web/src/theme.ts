import { theme, type ThemeConfig } from "antd";

export type ThemeMode = "dark" | "light";
export const THEME_STORAGE_KEY = "qingxuan-theme";

export const themeColors = {
  dark: {
    background: "#141618", surface: "#1c1f22", elevated: "#25292d", border: "#363c42",
    text: "#f1f3f5", secondary: "#aab4bf", primary: "#53d6bd", success: "#83d98e",
    info: "#7db7ff", warning: "#f2c066", error: "#ff8087"
  },
  light: {
    background: "#f5f6f8", surface: "#ffffff", elevated: "#ffffff", border: "#dde2e7",
    text: "#182026", secondary: "#56616d", primary: "#087f6b", success: "#267239",
    info: "#245cb4", warning: "#8b5e00", error: "#b42335"
  }
} as const;

export function getAppTheme(mode: ThemeMode): ThemeConfig {
  const dark = mode === "dark";
  const colors = themeColors[mode];
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: colors.primary,
      colorInfo: colors.info,
      colorLink: colors.info,
      colorLinkHover: colors.primary,
      colorSuccess: colors.success,
      colorWarning: colors.warning,
      colorError: colors.error,
      colorBgBase: colors.background,
      colorBgLayout: colors.background,
      colorBgContainer: colors.surface,
      colorBgElevated: colors.elevated,
      colorText: colors.text,
      colorTextSecondary: colors.secondary,
      colorTextPlaceholder: colors.secondary,
      colorTextTertiary: colors.secondary,
      colorBorder: colors.border,
      colorBorderSecondary: colors.border,
      borderRadius: 6,
      fontFamily: '"Avenir Next", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Droid Sans Fallback", sans-serif'
    },
    components: {
      Button: { controlHeight: 34, primaryColor: dark ? "#101c18" : "#ffffff" },
      Input: { controlHeight: 34 },
      Menu: { itemBorderRadius: 5, itemHeight: 42, itemMarginInline: 10 }
    }
  };
}
