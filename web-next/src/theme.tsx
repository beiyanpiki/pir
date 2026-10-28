import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { App as AntApp, type ThemeConfig, theme as antdTheme } from "antd";
import { XProvider } from "@ant-design/x";

export type ThemeMode = "dark" | "light";

interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "pir-web-next-theme";

function initialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Storage can be unavailable in private mode; the default still works.
  }
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Optional preference.
    }
  }, [mode]);

  const toggle = useCallback(() => setMode((value) => (value === "dark" ? "light" : "dark")), []);
  const value = useMemo(() => ({ mode, toggle }), [mode, toggle]);

  const config = useMemo<ThemeConfig>(() => {
    const dark = mode === "dark";
    return {
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: dark ? "#7aa2f7" : "#2f6fed",
        colorInfo: dark ? "#7aa2f7" : "#2f6fed",
        colorSuccess: dark ? "#6fcf97" : "#2f855a",
        colorWarning: dark ? "#f2c94c" : "#b7791f",
        colorError: dark ? "#f28b82" : "#c53030",
        colorBgLayout: dark ? "#0f131a" : "#f4f6fa",
        colorBgContainer: dark ? "#161c26" : "#ffffff",
        colorBgElevated: dark ? "#1c232f" : "#ffffff",
        colorBorderSecondary: dark ? "#283040" : "#e2e8f0",
        colorTextSecondary: dark ? "#aab4c5" : "#526077",
        borderRadius: 8,
        fontSize: 14,
        fontFamily:
          'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "PingFang SC", sans-serif',
        controlHeight: 36,
        lineHeight: 1.55,
      },
      components: {
        Layout: {
          headerBg: dark ? "#121821" : "#ffffff",
          siderBg: dark ? "#121821" : "#ffffff",
          bodyBg: dark ? "#0f131a" : "#f4f6fa",
        },
        Menu: {
          itemBg: "transparent",
          itemHeight: 38,
        },
        Card: {
          headerBg: "transparent",
        },
        Table: {
          headerBg: dark ? "#1a212c" : "#f5f7fa",
        },
        Tabs: {
          horizontalItemPadding: "10px 4px",
        },
      },
    };
  }, [mode]);

  return (
    <XProvider theme={config}>
      <AntApp
        message={{ maxCount: 3 }}
        notification={{ placement: "bottomRight", maxCount: 3 }}
      >
        <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
      </AntApp>
    </XProvider>
  );
}

export function useThemeMode(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) throw new Error("useThemeMode must be used inside ThemeProvider");
  return context;
}
