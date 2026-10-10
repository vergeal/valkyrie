import * as monaco from "./monaco";
import type { ThemeMode } from "../settings";

/**
 * 深色主题的 Monaco 配色：底色对齐 IntelliJ New UI Dark（#1e1f22，中性深灰而非近黑），
 * token 颜色沿用较柔和的色板（注释灰、关键字红、字符串浅蓝、数字 / 常量蓝、类型橙）。
 * 只在首次切到深色时注册一次。
 */
let githubDarkReady = false;

export function ensureGithubDarkTheme() {
  if (githubDarkReady)
    return;

  monaco.editor.defineTheme("valkyrie-github-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "bcbec4", background: "1e1f22" },
      /* 语法色在 GitHub Dark 的基础上降一档饱和度：色相不变，长时间看不那么扎眼 */
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "keyword", foreground: "e1938e" },
      { token: "string", foreground: "a6bfd8" },
      { token: "number", foreground: "93bee4" },
      { token: "operator", foreground: "e1938e" },
      { token: "delimiter", foreground: "bcbec4" },
      { token: "identifier", foreground: "bcbec4" },
      { token: "predefined", foreground: "93bee4" },
      { token: "type", foreground: "dda878" },
      { token: "variable", foreground: "dda878" }
    ],
    colors: {
      "editor.background": "#1e1f22",
      "editor.foreground": "#bcbec4",
      "editorLineNumber.foreground": "#6f737a",
      "editorLineNumber.activeForeground": "#bcbec4",
      "editor.lineHighlightBackground": "#2b2d30",
      "editor.selectionBackground": "#2e436e",
      "editor.inactiveSelectionBackground": "#313335",
      "editor.selectionHighlightBackground": "#2e436e",
      "editorCursor.foreground": "#548af7",
      "editorWhitespace.foreground": "#393b40",
      "editorIndentGuide.background1": "#313335",
      "editorIndentGuide.activeBackground1": "#393b40",
      "editorGutter.background": "#1e1f22",
      "editorWidget.background": "#2b2d30",
      "editorWidget.border": "#393b40",
      "editorSuggestWidget.background": "#2b2d30",
      "editorSuggestWidget.border": "#393b40",
      "editorSuggestWidget.selectedBackground": "#393b40",
      "editorSuggestWidget.highlightForeground": "#548af7",
      "editorHoverWidget.background": "#2b2d30",
      "editorHoverWidget.border": "#393b40",
      "editorBracketMatch.background": "#2e436e",
      "editorBracketMatch.border": "#548af7",
      "scrollbarSlider.background": "#484f5866",
      "scrollbarSlider.hoverBackground": "#484f5880",
      "scrollbarSlider.activeBackground": "#484f58b3"
    }
  });

  githubDarkReady = true;
}

/** 主题的解析结果（system 时看系统偏好） */
export function resolveThemeMode(theme: ThemeMode): "dark" | "light" {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

/**
 * 主题落到 Monaco 上：深色用 GitHub Dark，浅色保持 Monaco 默认的 vs。
 *
 * 编辑器创建时要再调一次：`create()` 会按传入的 theme 重置 Monaco 的全局主题，
 * 冷启动就是深色时不管这一步，脚本配色和当前行边框都会是浅色主题的，
 * 非得手动切一次主题才恢复（create 的 theme 选项写死过 "vs"）。
 */
export function applyEditorTheme(theme: ThemeMode): void {
  const resolved = resolveThemeMode(theme);

  if (resolved === "dark")
    ensureGithubDarkTheme();

  monaco.editor.setTheme(resolved === "dark" ? "valkyrie-github-dark" : "vs");
}
