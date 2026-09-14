import { listFonts, loadSettingsFile, saveSettingsFile } from "./api";
import { IS_MAC } from "./keys";

export type ThemeMode = "light" | "dark" | "system";

/** 字体选择里的「系统默认」哨兵值 */
export const SYSTEM_FONT = "system";

export type FontKind = "ui" | "editor" | "grid";

/**
 * 各平台、各用途的「系统默认」字体栈：
 * 界面用系统无衬线字体；macOS 编辑器默认 Monaco、数据表格默认 Menlo；Windows 等宽都用 Consolas。
 */
export function systemFontStack(kind: FontKind): string {
  if (kind === "ui")
    return IS_MAC
      ? '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", system-ui, sans-serif'
      : '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif';

  if (IS_MAC)
    return kind === "editor"
      ? 'Monaco, Menlo, "SF Mono", "PingFang SC", monospace'
      : 'Menlo, Monaco, "SF Mono", "PingFang SC", monospace';

  return 'Consolas, "Cascadia Mono", "Courier New", monospace';
}

/** 设置里的字体名 → CSS font-family：系统默认按用途展开，具体字体也回退到系统等宽 */
export function resolveFontFamily(value: string | undefined, kind: FontKind): string {
  if (!value || value === SYSTEM_FONT)
    return systemFontStack(kind);

  return `"${value}", ${systemFontStack(kind)}`;
}

export interface FontOption {
  value: string;
  label: string;
}

/* 常见编程字体兜底：即使本机没装也列出来，方便按使用习惯选（没有则回退系统等宽） */
export const FALLBACK_FONT_FAMILIES = [
  "Consolas",
  "Cascadia Mono",
  "JetBrains Mono",
  "Fira Code",
  "Menlo",
  "Monaco",
  "Courier New"
];

/** 枚举本机已安装的字体族：主进程用系统接口拿，Chromium 的 Local Font Access 没暴露 */
let systemFontsCache: string[] | null = null;

export async function listSystemFonts(): Promise<string[]> {
  if (systemFontsCache)
    return systemFontsCache;

  let families: string[] = [];

  try {
    families = await listFonts();
  } catch {
    families = [];
  }

  if (families.length > 0)
    systemFontsCache = families;

  return families;
}

let fontsWarmedUp = false;

/**
 * 让浏览器把每个字体族先渲染一次（离屏、分批走空闲时段），
 * 把字体载入字体缓存，避免第一次打开字体下拉时逐项卡顿。
 */
function warmUpFonts(families: string[]): void {
  if (fontsWarmedUp || families.length === 0 || typeof document === "undefined" || !document.body)
    return;

  fontsWarmedUp = true;

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none;white-space:nowrap;";
  document.body.appendChild(container);

  const schedule = (fn: () => void) => {
    const idle = (window as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;

    if (idle)
      idle(fn, { timeout: 1500 });
    else
      window.setTimeout(fn, 16);
  };

  let index = 0;

  const step = () => {
    const batch = families.slice(index, index + 32);

    for (const family of batch) {
      const span = document.createElement("span");
      span.style.fontFamily = `"${family}"`;
      span.textContent = "中文 Aa 0123";
      container.appendChild(span);
    }

    index += batch.length;

    if (index < families.length)
      schedule(step);
    else
      window.setTimeout(() => container.remove(), 2000);
  };

  schedule(step);
}

/** 启动时调用：先拿到字体列表并预热，之后打开设置里的字体下拉不再现算 / 卡顿 */
export function preloadSystemFonts(): void {
  void listSystemFonts().then(warmUpFonts);
}

export interface AppSettings {
  /** 主题模式 */
  theme: ThemeMode;
  /** 界面基准字号（px） */
  uiFontSize: number;
  /** 界面字体 */
  uiFontFamily: string;
  /** 编辑器字号（px） */
  editorFontSize: number;
  /** 编辑器字体 */
  editorFontFamily: string;
  /** 编辑器自动换行 */
  editorWordWrap: boolean;
  /** 编辑器智能提示 */
  suggestEnabled: boolean;
  /** 编辑器显示行号 */
  editorLineNumbers: boolean;
  /** 编辑器缩进宽度 */
  editorTabSize: number;
  /** 显示空格 / 制表符与缩进参考线（默认关闭：满屏的点和竖线很吵） */
  editorWhitespace: boolean;
  /** 编辑器显示缩略图 */
  editorMinimap: boolean;
  /** 结果表格字号（px） */
  gridFontSize: number;
  /** 结果表格字体 */
  gridFontFamily: string;
  /** 结果表格斑马纹 */
  gridZebra: boolean;
  /** 结果表格显示行号列 */
  gridRowNumbers: boolean;
  /** 结果表头显示字段类型 */
  gridHeaderType: boolean;
  /** 数据页默认取行数 */
  pageSize: number;
  /** 日志最多保留条数 */
  logLimit: number;
  /** 启动时最大化窗口 */
  startMaximized: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  uiFontSize: 14,
  uiFontFamily: SYSTEM_FONT,
  editorFontSize: 14,
  editorFontFamily: SYSTEM_FONT,
  editorWordWrap: false,
  suggestEnabled: true,
  editorLineNumbers: true,
  editorTabSize: 4,
  editorWhitespace: false,
  editorMinimap: false,
  gridFontSize: 14,
  gridFontFamily: SYSTEM_FONT,
  gridZebra: true,
  gridRowNumbers: true,
  gridHeaderType: true,
  pageSize: 200,
  logLimit: 2048,
  startMaximized: true
};

const STORAGE_KEY = "valkyrie.settings";

export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 17, 18];
export const UI_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16];
export const GRID_FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15];
export const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000, 2000];
export const TAB_SIZE_OPTIONS = [2, 4, 8];
export const LOG_LIMIT_OPTIONS = [1024, 2048, 4096, 8192];

/** 读取本地设置：缺字段用默认值补齐，坏数据不抛异常 */
export function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<AppSettings> : {};

    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 存储不可用时静默忽略，不影响使用 */
  }

  /* 同时写主进程的配置文件：localStorage 只当首屏兜底，文件才是持久的 */
  void saveSettingsFile({ ...settings });
}

/**
 * 启动时用主进程里的 settings.json 校准一次。
 * 文件有内容就以它为准；没有（首次运行 / 老版本升级）就沿用当前这份（localStorage 读出来的）。
 */
export async function hydrateSettings(current: AppSettings): Promise<AppSettings> {
  const file = await loadSettingsFile().catch(() => ({} as Record<string, unknown>));

  if (Object.keys(file).length === 0)
    return current;

  return { ...current, ...file } as AppSettings;
}
