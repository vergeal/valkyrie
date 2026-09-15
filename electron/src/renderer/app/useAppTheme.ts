import { useEffect } from "react";
import { setNativeTheme } from "../api";
import type { AppSettings, ThemeMode } from "../settings";
import { applyEditorTheme } from "../editor/editorTheme";

/**
 * 主题跟着设置一起持久化（settings.theme）。
 * 默认浅色（与设计稿一致），system 时按系统偏好解析；原生菜单 / 对话框也跟随。
 */
export function useAppTheme(settings: AppSettings, updateSettings: (patch: Partial<AppSettings>) => void) {
  const theme = settings.theme;

  function setTheme(next: ThemeMode) {
    updateSettings({ theme: next });
  }

  /* 主题：默认浅色（与设计稿一致），不跟随 Windows 深色模式 */
  useEffect(() => {
    document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;

    /* 深色用 GitHub Dark 配色，浅色保持 Monaco 默认的 vs */
    applyEditorTheme(theme);
    /* 系统原生菜单 / 对话框也跟随应用主题 */
    void setNativeTheme(theme);
  }, [theme]);

  /* 主题的解析结果（system 时看系统偏好）：供样式分支用，和主题 effect 同一套判断 */
  const themeResolved: "dark" | "light" = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;

  return { theme, setTheme, themeResolved };
}
