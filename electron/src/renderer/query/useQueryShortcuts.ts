import { useEffect, useRef } from "react";
import type * as monaco from "monaco-editor";
import { onShortcut } from "../api";
import type { QueryResultPayload } from "../api";
import type { WorkTab } from "../app/appTypes";
import type { GridSelection } from "../result/resultHelpers";

/** 编辑器命令用的三个「当前处理函数」ref（创建后再回填，避免闭包在首次渲染状态上）。 */
export function useEditorShortcutRefs() {
  const runShortcutRef = useRef<() => void>(() => undefined);
  const formatShortcutRef = useRef<() => void>(() => undefined);
  const saveShortcutRef = useRef<(saveAs?: boolean) => void>(() => undefined);

  return { runShortcutRef, formatShortcutRef, saveShortcutRef };
}

export interface QueryShortcutsDeps {
  runShortcutRef: { current: () => void };
  formatShortcutRef: { current: () => void };
  saveShortcutRef: { current: (saveAs?: boolean) => void };
  runSelectionOrAll: () => void;
  formatActiveQuery: () => void;
  saveActiveScript: (saveAs?: boolean) => void;
  activeTab: WorkTab | null;
  editorRef: { current: monaco.editor.IStandaloneCodeEditor | null };
  gridSelection: GridSelection | null;
  currentResult: QueryResultPayload | null;
  copyGridSelection: () => void;
  setTableSelection: (names: string[]) => void;
  setScriptSelection: (paths: string[]) => void;
  setStatus: (message: string) => void;
  setOptionsOpen: (open: boolean) => void;
}

/**
 * 窗口级快捷键：Ctrl+R 执行、Ctrl+A 全选、Ctrl+C 复制选区、
 * Ctrl+Shift+F 格式化、Ctrl+S / Ctrl+Shift+S 保存脚本，以及 macOS 原生菜单转发的 ⌘A / ⌘C。
 */
export function useQueryShortcuts(deps: QueryShortcutsDeps) {
  const {
    runShortcutRef, formatShortcutRef, saveShortcutRef,
    runSelectionOrAll, formatActiveQuery, saveActiveScript,
    activeTab, editorRef, gridSelection, currentResult, copyGridSelection,
    setTableSelection, setScriptSelection, setStatus, setOptionsOpen
  } = deps;

  runShortcutRef.current = () => void runSelectionOrAll();
  formatShortcutRef.current = () => void formatActiveQuery();
  saveShortcutRef.current = (saveAs?: boolean) => void saveActiveScript(saveAs);

  /**
   * 全选（⌘/Ctrl+A、编辑菜单、macOS 菜单栏转发过来）：
   * 输入框里选中文本、对象页/脚本页全选行、其余情况选编辑器全文。
   */
  function selectAllInPage() {
    const focused = document.activeElement as HTMLElement | null;

    if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) {
      (focused as HTMLInputElement).select();
      return;
    }

    if (activeTab?.kind === "objects" && activeTab.view === "tables" && activeTab.tables.length > 0) {
      setTableSelection(activeTab.tables.map(node => node.label));
      setStatus(`已全选 ${activeTab.tables.length} 张表`);
      return;
    }

    if (activeTab?.kind === "objects" && activeTab.view === "scripts" && activeTab.scripts.length > 0) {
      setScriptSelection(activeTab.scripts.map(script => script.path));
      setStatus(`已全选 ${activeTab.scripts.length} 个脚本`);
      return;
    }

    editorRef.current?.trigger("menu", "editor.action.selectAll", null);
  }

  const selectAllRef = useRef<() => void>(() => undefined);
  selectAllRef.current = () => void selectAllInPage();

  /**
   * Ctrl+C 的复制入口：只有「结果表」上下文才接管（对象页 / 设计页没有网格，
   * 那里的选区是上一个标签留下来的，不能拿它覆盖系统默认复制）。
   * 返回 true 表示这次按键已经被处理，调用方要 preventDefault。
   */
  const gridCopyRef = useRef<() => boolean>(() => false);
  gridCopyRef.current = () => {
    const gridTab = activeTab?.kind === "query" || activeTab?.kind === "data";

    if (!gridTab || !gridSelection || !currentResult?.rows)
      return false;

    void copyGridSelection();
    return true;
  };

  /* macOS 菜单栏把 ⌘A 转发过来（原生菜单会先吃掉这个组合键） */
  useEffect(() => onShortcut(action => {
    if (action === "select-all")
      selectAllRef.current();

    /* macOS 菜单栏把 ⌘C 转发过来：结果表有选区就复制成制表符分隔，否则走系统默认复制 */
    if (action === "copy") {
      const focused = document.activeElement as HTMLElement | null;
      const typing = Boolean(focused?.closest?.("input, textarea, .editor"));

      if (typing || !gridCopyRef.current())
        document.execCommand?.("copy");
    }
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey)
        return;

      const key = event.key.toLowerCase();
      const shift = event.shiftKey;
      const target = event.target as HTMLElement | null;

      /* 选项：⌘/Ctrl+,（macOS 由原生菜单项转发，这里兜住 Windows / Linux 与输入焦点内） */
      if (!shift && key === ",") {
        event.preventDefault();
        setOptionsOpen(true);
        return;
      }

      /* 执行：Monaco 没绑 Ctrl+R，编辑器里也必须在这里处理，否则按了没反应 */
      if (!shift && key === "r") {
        event.preventDefault();
        runShortcutRef.current();
        return;
      }

      /* ⌘/Ctrl+Enter 同样执行（编辑器里由 Monaco 处理，这里兜住其它焦点） */
      if (!shift && key === "enter" && !target?.closest?.("input, textarea")) {
        event.preventDefault();
        runShortcutRef.current();
        return;
      }

      /* 输入框里的 Ctrl+A 让浏览器自己全选文本，别抢 */
      if (!shift && key === "a" && !target?.closest?.("input, textarea")) {
        event.preventDefault();
        selectAllRef.current();
        return;
      }

      /* 其余快捷键在编辑器里交给 Monaco，避免同一个动作触发两次 */
      if (target?.closest?.(".editor"))
        return;

      /* Ctrl+C / Ctrl+Insert：结果表有选区就复制成「制表符分隔」，粘到 Excel 直接分格 */
      if (!shift && (key === "c" || key === "insert")) {
        if (!target?.closest?.("input, textarea") && gridCopyRef.current())
          event.preventDefault();

        return;
      }

      if (shift && key === "f") {
        event.preventDefault();
        formatShortcutRef.current();
        return;
      }

      if (key === "s") {
        event.preventDefault();
        saveShortcutRef.current(shift);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { selectAllInPage, gridCopyRef };
}
