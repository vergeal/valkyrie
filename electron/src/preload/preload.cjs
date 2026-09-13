"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * 渲染层唯一的对外通道：调用数据层方法 + 订阅数据层通知。
 * 渲染层不接触任何 Node / Electron API。
 */
contextBridge.exposeInMainWorld("valkyrie", {
  /* 平台标识：界面据此切换 ⌘ / Ctrl 的快捷键提示、macOS 的窗口按钮 */
  platform: process.platform,

  invoke: (method, params) => ipcRenderer.invoke("valkyrie:invoke", method, params),

  onEvent: callback => {
    const listener = (_event, params) => callback(params);

    ipcRenderer.on("valkyrie:event", listener);

    return () => ipcRenderer.off("valkyrie:event", listener);
  },

  /* 自绘标题栏的窗口控制 */
  windowControl: action => ipcRenderer.send("valkyrie:window", action),

  onWindowState: callback => {
    const listener = (_event, state) => callback(state);

    ipcRenderer.on("valkyrie:window-state", listener);

    return () => ipcRenderer.off("valkyrie:window-state", listener);
  },

  /* macOS 菜单栏转发过来的快捷键（原生菜单会先吃掉 ⌘A） */
  onShortcut: callback => {
    const listener = (_event, action) => callback(action);

    ipcRenderer.on("valkyrie:shortcut", listener);

    return () => ipcRenderer.off("valkyrie:shortcut", listener);
  },

  /* 导出另存为 / 在文件夹中显示 */
  chooseSavePath: options => ipcRenderer.invoke("valkyrie:choose-save-path", options),

  /* 选择本地文件（SQLite 数据库文件等） */
  chooseOpenPath: options => ipcRenderer.invoke("valkyrie:choose-open-path", options),

  revealPath: target => ipcRenderer.invoke("valkyrie:reveal-path", target),

  /* 系统原生消息框（错误提示等） */
  showMessage: options => ipcRenderer.invoke("valkyrie:show-message", options),

  /* 系统原生右键菜单：返回被选中项的 id */
  showMenu: options => ipcRenderer.invoke("valkyrie:show-menu", options),

  /* 让原生菜单 / 系统对话框跟随应用主题 */
  setNativeTheme: theme => ipcRenderer.invoke("valkyrie:set-native-theme", theme),

  /* 客户端设置：主进程写到 userData/settings.json */
  loadSettings: () => ipcRenderer.invoke("valkyrie:settings-load"),
  saveSettings: settings => ipcRenderer.invoke("valkyrie:settings-save", settings)
});
