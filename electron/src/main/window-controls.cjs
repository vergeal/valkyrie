"use strict";

const { BrowserWindow, ipcMain } = require("electron");

const CHANNEL_CONTROL = "valkyrie:window";
const CHANNEL_STATE = "valkyrie:window-state";

/**
 * 自绘标题栏的窗口控制（最小化 / 最大化 / 关闭）。
 * 无边框窗口没有系统按钮，这里统一由渲染层驱动。
 */
function registerWindowControls() {
  ipcMain.on(CHANNEL_CONTROL, (event, action) => {
    const target = BrowserWindow.fromWebContents(event.sender);

    if (!target)
      return;

    if (action === "minimize")
      target.minimize();
    else if (action === "maximize")
      target.isMaximized() ? target.unmaximize() : target.maximize();
    else if (action === "close")
      target.close();
  });
}

/**
 * 把窗口最大化状态同步给渲染层，用于切换标题栏按钮图标。
 */
function attachWindowState(window) {
  const notify = () => {
    if (!window.isDestroyed())
      window.webContents.send(CHANNEL_STATE, { maximized: window.isMaximized() });
  };

  window.on("maximize", notify);
  window.on("unmaximize", notify);
  window.once("ready-to-show", notify);
}

/**
 * 屏蔽浏览器 / 默认菜单的快捷键：刷新、打印、查看源码、查找、缩放、开发者工具、
 * 前进后退等。编辑类快捷键（复制粘贴、撤销重做、全选）保留。
 * 注意：Ctrl+R 交给渲染层当作「执行查询」，Ctrl+W 交给编辑器做「智能扩选」，
 * 这两个都不能在这里拦掉（窗口本身没有系统菜单，Ctrl+W 不会误关窗口）。
 * 同理 Ctrl+F / Ctrl+G / Ctrl+H 不能拦：浏览器那套「页内查找 / 找下一个 / 历史」
 * 在桌面客户端里本来就没用，但它们是编辑器自己的「查找 / 跳到行 / 替换」。
 */
function disableBrowserShortcuts(window) {
  /* 这几个在浏览器里是打印 / 查看源码 / 下载 / 新窗口 / 打开文件 / 新标签页，客户端用不上 */
  const blockedWithCtrl = new Set(["p", "u", "j", "n", "o", "t"]);
  /* 缩放快捷键不管带不带 Shift 都拦掉，网页缩放对桌面客户端没意义 */
  const zoomKeys = new Set(["+", "-", "=", "0"]);
  const blockedKeys = new Set(["f5", "f7", "f12"]);

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown")
      return;

    const key = (input.key || "").toLowerCase();
    const ctrl = input.control || input.meta;
    const shift = input.shift;

    const blocked =
      /* 带 Shift 的组合放行（例如 Ctrl+Shift+F 格式化），单独的 Ctrl+X 才拦 */
      (ctrl && !shift && blockedWithCtrl.has(key)) ||
      (ctrl && zoomKeys.has(key)) ||
      blockedKeys.has(key) ||
      (ctrl && shift && (key === "i" || key === "j" || key === "c")) ||
      (input.alt && (key === "arrowleft" || key === "arrowright")) ||
      key === "browserback";

    if (blocked)
      event.preventDefault();
  });
}

module.exports = { registerWindowControls, attachWindowState, disableBrowserShortcuts };
