"use strict";

const { app, BrowserWindow, nativeTheme } = require("electron");
const path = require("node:path");

/* 卡片至少显示这么久，免得启动太快时一闪而过 */
const MIN_VISIBLE_MS = 700;

/**
 * 启动卡片（DBeaver 那种小窗口）：数据层起来之前先给用户一个反馈，
 * 主窗口 ready-to-show 后关闭。`VALKYRIE_NO_SPLASH=1` 可关掉（自动化脚本用）。
 */
function createSplash() {
  if (process.env.VALKYRIE_NO_SPLASH === "1" || !app.isReady())
    return null;

  const startedAt = Date.now();
  const dark = nativeTheme.shouldUseDarkColors;

  const window = new BrowserWindow({
    width: 420,
    height: 152,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    /* 不占任务栏，也不抢焦点：是个"进度卡片"，不是主窗口 */
    skipTaskbar: true,
    show: false,
    center: true,
    alwaysOnTop: true,
    roundedCorners: true,
    title: "Valkyrie 正在启动",
    backgroundColor: dark ? "#161b22" : "#f7f8fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  });

  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => {
    if (!window.isDestroyed())
      window.show();
  });

  void window.loadFile(path.join(__dirname, "splash.html"), {
    query: { v: app.getVersion() }
  });

  return {
    /** 更新卡片上的进度文案 */
    status(text) {
      if (window.isDestroyed())
        return;

      void window.webContents
        .executeJavaScript(`window.__setStatus(${JSON.stringify(text)})`)
        .catch(() => undefined);
    },

    /** 启动完成：留够最短显示时间后关掉卡片 */
    close() {
      const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt));

      setTimeout(() => {
        if (!window.isDestroyed())
          window.close();
      }, wait);
    }
  };
}

module.exports = { createSplash };
