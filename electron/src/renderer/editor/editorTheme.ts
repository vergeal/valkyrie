import * as monaco from "./monaco";
import type { ThemeMode } from "../settings";

/**
 * 深色主题的 Monaco 配色：对齐 GitHub Dark 的 token 颜色
 * （注释灰、关键字红、字符串浅蓝、数字 / 常量蓝、类型橙），编辑器底色 #0d1117。
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
      { token: "", foreground: "c9d1d9", background: "0d1117" },
      /* 语法色在 GitHub Dark 的基础上降一档饱和度：色相不变，长时间看不那么扎眼 */
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "keyword", foreground: "e1938e" },
      { token: "string", foreground: "a6bfd8" },
      { token: "number", foreground: "93bee4" },
      { token: "operator", foreground: "e1938e" },
      { token: "delimiter", foreground: "c9d1d9" },
      { token: "identifier", foreground: "c9d1d9" },
      { token: "predefined", foreground: "93bee4" },
      { token: "type", foreground: "dda878" },
      { token: "variable", foreground: "dda878" }
    ],
    colors: {
      "editor.background": "#0d1117",
      "editor.foreground": "#c9d1d9",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#e6edf3",
      "editor.lineHighlightBackground": "#161b22",
      "editor.selectionBackground": "#19416e",
      "editor.inactiveSelectionBackground": "#13233a",
      "editor.selectionHighlightBackground": "#13233a",
      "editorCursor.foreground": "#58a6ff",
      "editorWhitespace.foreground": "#21262d",
      "editorIndentGuide.background1": "#21262d",
      "editorIndentGuide.activeBackground1": "#30363d",
      "editorGutter.background": "#0d1117",
      "editorWidget.background": "#161b22",
      "editorWidget.border": "#30363d",
      "editorSuggestWidget.background": "#161b22",
      "editorSuggestWidget.border": "#30363d",
      "editorSuggestWidget.selectedBackground": "#21262d",
      "editorSuggestWidget.highlightForeground": "#58a6ff",
      "editorHoverWidget.background": "#161b22",
      "editorHoverWidget.border": "#30363d",
      "editorBracketMatch.background": "#13233a",
      "editorBracketMatch.border": "#58a6ff",
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
