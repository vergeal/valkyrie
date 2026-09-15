import type { ThemeMode } from "../settings";

export const DEFAULT_SQL = "";

export const NEXT_THEME: Record<ThemeMode, ThemeMode> = { light: "dark", dark: "system", system: "light" };
export const THEME_LABEL: Record<ThemeMode, string> = { light: "浅色", dark: "深色", system: "跟随系统" };
export const THEME_ICON: Record<ThemeMode, string> = { light: "sun", dark: "moon", system: "system" };

/* 对象列的标签标题固定，不写成「xxx 对象」 */
export const OBJECT_TAB_TITLE = "对象";
