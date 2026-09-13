"use strict";

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { JavaBridge } = require("./java-bridge.cjs");
const { createSplash } = require("./splash.cjs");
const { registerWindowControls, attachWindowState, disableBrowserShortcuts } = require("./window-controls.cjs");

/* 防止用户重复启动导致起两份数据层进程，抢占同一份连接配置 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let bridge = null;
let mainWindow = null;
let splash = null;

function rendererEntry() {
  return path.join(__dirname, "..", "..", "dist", "renderer", "index.html");
}

/**
 * 菜单栏：Windows / Linux 不需要浏览器默认菜单（里面的刷新、开发者工具等快捷键一并去掉），
 * macOS 则必须保留一份，否则 ⌘Q、⌘H 以及输入框里的 ⌘C / ⌘V 都会失效。
 * ⌘A 不注册成 selectAll role，改为转发给渲染层 —— 对象页 / 脚本页要全选表格里的行。
 */
function installApplicationMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        /*
         * 复制自己转发到渲染层：结果表有选区时复制成制表符分隔（粘 Excel 直接分格），
         * 编辑器 / 输入框里仍然按系统默认复制（渲染层会执行 execCommand("copy")）。
         * 用 role 的话这个组合键会被菜单直接吃掉，渲染层收不到。
         */
        {
          label: "复制",
          accelerator: "CommandOrControl+C",
          click: (_item, window) => window?.webContents.send("valkyrie:shortcut", "copy")
        },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { type: "separator" },
        {
          label: "全选",
          accelerator: "CommandOrControl+A",
          click: (_item, window) => window?.webContents.send("valkyrie:shortcut", "select-all")
        }
      ]
    },
    /* 自己列窗口菜单，避免默认模板里带 ⌘W 关闭窗口（那个键留给编辑器的智能扩选） */
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" }
      ]
    }
  ]));
}

function createWindow() {
  const isMac = process.platform === "darwin";

  installApplicationMenu();

  /* 读一下客户端设置：启动是否最大化（默认是） */
  let startMaximized = true;

  try {
    const settings = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"));

    if (typeof settings.startMaximized === "boolean")
      startMaximized = settings.startMaximized;
  } catch {
    /* 没有配置文件就用默认值 */
  }

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: "#e7e9ee",
    title: "VALKYRIE",
    /* Windows/Linux 使用自绘标题栏；macOS 保留原生红绿灯按钮 */
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  /* 默认以最大化打开（先最大化再显示，避免先闪一下小窗口） */
  mainWindow.once("ready-to-show", () => {
    if (startMaximized)
      mainWindow.maximize();

    mainWindow.show();
    /* 主窗口出来了，启动卡片可以收掉 */
    splash?.close();
    splash = null;
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  disableBrowserShortcuts(mainWindow);

  attachWindowState(mainWindow);

  if (process.env.VALKYRIE_DEV === "1")
    mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.loadFile(rendererEntry());
}

function registerIpc() {
  /*
   * 客户端设置（字体、表格、编辑器等）落到 userData/settings.json，
   * 由主进程负责读写：渲染层的 localStorage 只作为首次绘制的兜底。
   */
  const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

  ipcMain.handle("valkyrie:settings-load", async () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    } catch {
      return {};
    }
  });

  ipcMain.handle("valkyrie:settings-save", async (_event, settings) => {
    try {
      const target = settingsFile();

      fs.mkdirSync(path.dirname(target), { recursive: true });
      /* 先写临时文件再改名，避免写一半被打断留下坏配置 */
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(settings, null, 2), "utf8");
      fs.renameSync(`${target}.tmp`, target);
      return true;
    } catch (error) {
      process.stderr.write(`[valkyrie] 设置保存失败: ${error && error.message}\n`);
      return false;
    }
  });

  ipcMain.handle("valkyrie:invoke", async (_event, method, params) => {
    try {
      return { ok: true, result: await bridge.call(method, params || {}) };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  });

  registerWindowControls();

  /* 导出另存为：由主进程弹系统对话框，返回用户选择的路径 */
  ipcMain.handle("valkyrie:choose-save-path", async (event, options) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner, {
      title: options?.title || "保存文件",
      defaultPath: options?.defaultPath,
      filters: options?.filters || [{ name: "所有文件", extensions: ["*"] }]
    });

    return result.canceled ? null : result.filePath;
  });

  /* 在系统文件管理器中定位文件 */
  ipcMain.handle("valkyrie:reveal-path", async (_event, target) => {
    if (target)
      shell.showItemInFolder(target);

    return true;
  });

  /* 选择文件（SQLite 数据库文件等）：由主进程弹系统对话框 */
  ipcMain.handle("valkyrie:choose-open-path", async (event, options) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: options?.title || "选择文件",
      defaultPath: options?.defaultPath,
      properties: options?.directory ? ["openDirectory"] : ["openFile"],
      filters: options?.filters || [{ name: "所有文件", extensions: ["*"] }]
    });

    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  /*
   * 系统原生消息框（错误 / 提示）：模态挂在主窗口上，不走网页弹层。
   * 自动化脚本可设 VALKYRIE_SUPPRESS_DIALOGS=1 跳过，避免阻塞。
   */
  ipcMain.handle("valkyrie:show-message", async (event, options) => {
    if (process.env.VALKYRIE_SUPPRESS_DIALOGS === "1")
      return 0;

    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showMessageBox(owner, {
      type: options?.type || "info",
      title: options?.title || "Valkyrie",
      message: options?.message || "",
      detail: options?.detail,
      buttons: options?.buttons?.length ? options.buttons : ["确定"],
      defaultId: 0,
      noLink: true,
      /* 错误类用系统警示音与图标 */
      icon: undefined
    });

    return result.response;
  });

  /*
   * 系统原生右键菜单：渲染层把菜单项发过来，主进程用 Menu.popup 弹出，
   * 选中哪一项通过 Promise 回传该项 id（未选中返回 null）。
   */
  ipcMain.handle("valkyrie:show-menu", async (event, options) => {
    const owner = BrowserWindow.fromWebContents(event.sender);

    if (!owner)
      return null;

    return new Promise(resolve => {
      /* 渲染层传过来的菜单项（含二级菜单）→ 原生菜单模板 */
      const toTemplateItem = item => item.type === "separator"
        ? { type: "separator" }
        : {
            id: item.id,
            label: item.label,
            enabled: item.enabled !== false,
            /* 快捷键提示画在菜单右侧；不注册成全局快捷键，避免和编辑器内的键位打架 */
            accelerator: item.accelerator || undefined,
            registerAccelerator: false,
            /* 渲染层传过来的是 PNG data URL，转成原生图像 */
            icon: item.icon ? nativeImage.createFromDataURL(item.icon) : undefined,
            /* 有子项就是二级菜单，父项本身不挂点击 */
            submenu: item.submenu?.length ? item.submenu.map(toTemplateItem) : undefined,
            click: item.submenu?.length ? undefined : () => resolve(item.id ?? null)
          };

      const template = (options?.items || []).map(toTemplateItem);

      const menu = Menu.buildFromTemplate(template);

      /*
       * 自动化钩子：设置 VALKYRIE_MENU_PICK 后不弹窗，直接按标签包含匹配选中一项，
       * 便于冒烟脚本驱动原生菜单（原生菜单不在 DOM 里，无法用选择器点击）。
       */
      const pick = process.env.VALKYRIE_MENU_PICK;

      if (pick) {
        /* 自动化钩子：二级菜单也要能找到 */
        const findDeep = items => {
          for (const item of items) {
            if (item.label && String(item.label).includes(pick))
              return item;

            const nested = item.submenu ? findDeep(item.submenu) : null;

            if (nested)
              return nested;
          }

          return null;
        };

        const matched = findDeep(template);
        resolve(matched ? matched.id ?? null : null);
        return;
      }

      menu.popup({
        window: owner,
        /* 不传坐标：默认在当前鼠标位置弹出（右键所在处），省掉坐标系换算 */
        /* 关闭（含点到空白处）时返回 null */
        callback: () => resolve(null)
      });
    });
  });

  /* 原生菜单 / 系统对话框跟随应用主题 */
  ipcMain.handle("valkyrie:set-native-theme", async (_event, theme) => {
    nativeTheme.themeSource = theme === "dark" || theme === "light" ? theme : "system";
    return nativeTheme.shouldUseDarkColors;
  });
}

app.on("second-instance", () => {
  if (!mainWindow)
    return;

  if (mainWindow.isMinimized())
    mainWindow.restore();

  mainWindow.focus();
});

app.whenReady().then(async () => {
  /* 先把启动卡片立起来：数据层要起 JVM、读配置，这段时间用户得有反馈 */
  splash = createSplash();
  splash?.status("正在启动数据层…");

  bridge = new JavaBridge();

  bridge.on("log", chunk => process.stderr.write(`[data-layer] ${chunk}`));

  bridge.on("event", params => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("valkyrie:event", params);
  });

  bridge.on("exit", code => {
    if (code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "数据层已退出",
        message: `数据层进程异常退出（code=${code}），请重启应用。`
      });
    }
  });

  registerIpc();

  try {
    await bridge.start();
  } catch (error) {
    splash?.close();
    splash = null;
    dialog.showErrorBox("数据层启动失败", String(error && error.message ? error.message : error));
    app.quit();
    return;
  }

  splash?.status("正在加载界面…");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin")
    app.quit();
});

let stopping = false;

app.on("before-quit", event => {
  if (stopping || !bridge)
    return;

  event.preventDefault();
  stopping = true;

  bridge.stop().finally(() => app.quit());
});
