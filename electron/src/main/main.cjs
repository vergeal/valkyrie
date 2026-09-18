"use strict";

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, nativeImage, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
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
/* 启动是否最大化（从设置读） */
let startMaximized = true;
/* 主窗口渲染完成 / 数据层就绪：两者都好了才显示窗口，让渲染层解析与 JVM 启动并行 */
let mainWindowReady = false;
let dataReady = false;

function revealMainWindow() {
  if (!dataReady || !mainWindowReady || !mainWindow)
    return;

  if (startMaximized)
    mainWindow.maximize();

  mainWindow.show();
  splash?.close();
  splash = null;
}

function rendererEntry() {
  return path.join(__dirname, "..", "..", "dist", "renderer", "index.html");
}

/**
 * 应用图标（沿用 FX 版那份）：开发时读仓库里的 assets/icon.png，
 * 打包后由 electron-builder 放到 resources/icon.png。
 */
function appIconPath() {
  const packaged = path.join(process.resourcesPath || "", "icon.png");

  if (app.isPackaged && fs.existsSync(packaged))
    return packaged;

  return path.join(__dirname, "..", "..", "assets", "icon.png");
}

/* ********************************************************************* */
/*                            本机字体枚举                                */
/* ********************************************************************* */

/** 跑一个外部命令取输出（失败返回空串，不抛异常） */
function runCommand(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        resolve("");
        return;
      }

      /* osascript(JXA) 的 console.log 走 stderr，这里两边都兜一下 */
      const out = String(stdout || "").trim() || String(stderr || "").trim();
      resolve(out);
    });
  });
}

function uniqueSorted(lines) {
  const families = new Set();

  for (const line of lines) {
    const name = String(line).trim();

    if (name)
      families.add(name);
  }

  return [...families].sort((a, b) => a.localeCompare(b));
}

/** macOS：走 AppKit 的可用字体族（比 system_profiler 快得多）；console.log 输出到 stderr，用 JSON 收口 */
const MAC_FONT_SCRIPT = [
  'ObjC.import("AppKit");',
  "console.log(JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies)));"
].join("\n");

/** Windows：System.Drawing 的已安装字体集合（先把输出编码固定成 UTF-8，避免中文名乱码） */
const WIN_FONT_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
  "Add-Type -AssemblyName System.Drawing;",
  "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"
].join(" ");

/** 枚举本机字体族（按平台选最快的系统方式），结果进程内缓存 */
let fontFamiliesCache = null;

async function listSystemFontFamilies() {
  if (fontFamiliesCache)
    return fontFamiliesCache;

  let families = [];

  try {
    if (process.platform === "darwin") {
      const raw = await runCommand("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_FONT_SCRIPT]);
      let names = [];

      try {
        names = JSON.parse(raw);
      } catch {
        names = raw.split(/\r?\n/);
      }

      families = uniqueSorted(Array.isArray(names) ? names : []);
    } else if (process.platform === "win32") {
      families = uniqueSorted((await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_FONT_SCRIPT])).split(/\r?\n/));
    } else {
      const out = await runCommand("fc-list", [":", "family"]);
      families = uniqueSorted(out.split(/\r?\n/).flatMap(line => line.split(",")).map(part => part.trim()));
    }
  } catch {
    families = [];
  }

  if (families.length > 0)
    fontFamiliesCache = families;

  return families;
}

/**
 * 菜单栏：Windows / Linux 不需要浏览器默认菜单（里面的刷新、开发者工具等快捷键一并去掉），
 * macOS 则必须保留一份，否则 ⌘Q、⌘H 以及输入框里的 ⌘C / ⌘V 都会失效。
 * ⌘A 不注册成 selectAll role，改为转发给渲染层 —— 对象页 / 脚本页要全选表格里的行。
 */function installApplicationMenu() {
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

  mainWindowReady = false;

  /* 读一下客户端设置：启动是否最大化（默认是） */
  startMaximized = true;

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
    /* 任务栏 / 窗口图标（与 FX 版同一张） */
    icon: appIconPath(),
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

  /*
   * 权限：渲染层粘贴 / 写剪贴板要用 clipboard-*，其余权限不放开。
   * （字体枚举不走浏览器权限，改由主进程的系统接口拿，见 listSystemFontFamilies）
   */
  const allowedPermissions = new Set(["clipboard-read", "clipboard-sanitized-write"]);
  const windowSession = mainWindow.webContents.session;

  windowSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));
  windowSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });

  /* 渲染完成 + 数据层就绪后才显示（先最大化再显示，避免先闪一下小窗口） */
  mainWindow.once("ready-to-show", () => {
    mainWindowReady = true;
    revealMainWindow();
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
      /*
       * 窗口与数据层并行启动：渲染层可能在 JVM 就绪前就发来第一批调用（刷新连接列表），
       * 这里等 start() 完成再转发，调用方不会因为「数据层尚未就绪」而报错。
       */
      await bridge.start();
      return { ok: true, result: await bridge.call(method, params || {}) };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  });

  registerWindowControls();

  /*
   * 写系统剪贴板：结果表 / 对象列表的复制走主进程。
   * 渲染层的 navigator.clipboard.writeText 依赖「文档聚焦 + 用户激活」，
   * 从原生菜单 / 快捷键转发过来时经常不满足，会偶发失败（复制了但偶尔没内容）。
   */
  ipcMain.handle("valkyrie:write-clipboard", (_event, text) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });

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

  /* 本机字体：选项里的字体下拉用 */
  ipcMain.handle("valkyrie:list-fonts", async () => listSystemFontFamilies());

  /*
   * macOS 系统菜单栏：渲染层把整份菜单（文件 / 视图 / 数据库 …）发过来，
   * 这里用同一套动作 id 重建原生菜单；点击后把项 id 回传渲染层执行。
   * 非 macOS 不做处理，窗口内继续用自绘菜单栏。
   */
  ipcMain.handle("valkyrie:set-app-menu", (event, items) => {
    if (process.platform !== "darwin")
      return false;

    const sender = event.sender;

    /* 标准编辑动作必须用系统 role：否则输入框里的 ⌘Z / ⌘X 会失效 */
    const editRoles = [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { type: "separator" }
    ];

    const toItem = item => {
      if (!item || item.type === "separator")
        return { type: "separator" };

      const hasSubmenu = Boolean(item.submenu && item.submenu.length);

      return {
        label: item.label ?? "",
        enabled: item.enabled !== false,
        /* 快捷键由系统注册：⌘C / ⌘A 等会先被菜单吃掉再转发，行为与以前一致 */
        accelerator: item.accelerator || undefined,
        submenu: hasSubmenu ? item.submenu.map(toItem) : undefined,
        click: hasSubmenu ? undefined : () => {
          if (!sender.isDestroyed())
            sender.send("valkyrie:app-menu", item.id);
        }
      };
    };

    const template = [
      { role: "appMenu" },
      ...(items || []).map(menu => ({
        label: menu.label,
        submenu: [
          ...(menu.label === "编辑" ? editRoles : []),
          ...(menu.submenu || []).map(toItem)
        ]
      })),
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
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return true;
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
  /* Windows 任务栏按这个 id 归组，图标 / 名称才会跟着应用走 */
  app.setAppUserModelId("com.changhong.valkyrie");

  /* 先把启动卡片立起来：数据层要起 JVM、读配置，这段时间用户得有反馈 */
  splash = createSplash();
  splash?.status("正在启动数据层…");

  bridge = new JavaBridge({
    jvmArgs: [
      /* 无界面运行，省掉 AWT/显示相关初始化 */
      "-Djava.awt.headless=true",
      /* AppCDS：首次运行生成类共享归档，之后启动直接映射，类加载更快 */
      "-XX:+AutoCreateSharedArchive",
      `-XX:SharedArchiveFile=${path.join(app.getPath("userData"), "valkyrie.jsa")}`
    ]
  });

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

  /*
   * 先把窗口建起来（隐藏，不显示）：渲染层解析 4MB 级 bundle 与 JVM 启动并行，
   * 而不是等数据层 ready 之后再开始，首屏等待明显缩短。
   */
  createWindow();

  try {
    await bridge.start();
  } catch (error) {
    splash?.close();
    splash = null;
    dialog.showErrorBox("数据层启动失败", String(error && error.message ? error.message : error));
    app.quit();
    return;
  }

  dataReady = true;
  splash?.status("正在加载界面…");
  revealMainWindow();

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
