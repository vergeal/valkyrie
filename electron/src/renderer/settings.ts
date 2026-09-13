import { loadSettingsFile, saveSettingsFile } from "./api";

export type ThemeMode = "light" | "dark" | "system";

export interface AppSettings {
  /** 主题模式 */
  theme: ThemeMode;
  /** 界面基准字号（px） */
  uiFontSize: number;
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
  editorFontSize: 14,
  editorFontFamily: "Consolas",
  editorWordWrap: false,
  suggestEnabled: true,
  editorLineNumbers: true,
  editorTabSize: 4,
  editorWhitespace: false,
  editorMinimap: false,
  gridFontSize: 14,
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
export const EDITOR_FONT_OPTIONS = [
  "Consolas",
  "Cascadia Mono",
  "JetBrains Mono",
  "Fira Code",
  "Courier New"
];
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
