import { useEffect, useState } from "react";
import { hydrateSettings, loadSettings, resolveFontFamily, saveSettings, type AppSettings } from "../settings";

/**
 * 客户端设置：改完立即生效并落盘（localStorage + 主进程 settings.json）。
 * 启动时用主进程里的 settings.json 校准一次（localStorage 只当首屏兜底）。
 */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings(previous => {
      const next = { ...previous, ...patch };
      saveSettings(next);
      return next;
    });
  }

  /* 启动时用主进程里的 settings.json 校准一次（localStorage 只当首屏兜底） */
  useEffect(() => {
    void hydrateSettings(loadSettings()).then(loaded => setSettings(loaded));
  }, []);

  /* 选项：界面字号 / 表格字号、表格字体用 CSS 变量驱动，改完即时生效 */
  useEffect(() => {
    const root = document.documentElement.style;

    root.setProperty("--ui-font-size", `${settings.uiFontSize}px`);
    root.setProperty("--font", resolveFontFamily(settings.uiFontFamily, "ui"));
    root.setProperty("--grid-font-size", `${settings.gridFontSize}px`);
    root.setProperty("--grid-font", resolveFontFamily(settings.gridFontFamily, "grid"));
  }, [settings.uiFontSize, settings.uiFontFamily, settings.gridFontSize, settings.gridFontFamily]);

  return { settings, setSettings, updateSettings };
}
