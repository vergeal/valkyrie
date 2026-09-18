import { useEffect, useRef } from "react";
import * as monaco from "./monaco";
import EditorWorker from "../editor.worker?worker";
import { resolveFontFamily, type AppSettings } from "../settings";
import type { WorkTab } from "../app/appTypes";
import type { SqlResolver } from "../tabs/tabHelpers";
import { DEFAULT_SQL } from "../app/appConstants";
import { registerCompletionProvider, type SuggestionContext } from "./completionProvider";
import { ensureGithubDarkTheme, resolveThemeMode } from "./editorTheme";
import { isQuerySql } from "../query/sqlText";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

interface PanelHandle {
  collapse: () => void;
  expand: () => void;
  isCollapsed: () => boolean;
}

interface Ref<T> {
  current: T;
}

export interface UseMonacoEditorOptions {
  settings: AppSettings;
  containerRef: Ref<HTMLDivElement | null>;
  suggestionContextRef: Ref<SuggestionContext>;
  runShortcutRef: Ref<() => void>;
  formatShortcutRef: Ref<() => void>;
  saveShortcutRef: Ref<(saveAs?: boolean) => void>;
  onContentChange: (value: string) => void;
  activeTab: WorkTab | null;
  editorPanelRef: Ref<PanelHandle | null>;
  /** 取标签的最新编辑器内容（内容可能还没同步进 tabs 状态） */
  resolveSql?: SqlResolver;
  /** 选区 / 内容变化：报告当前（选区优先）是否为可分析的查询语句 */
  onSelectionChange?: (state: { hasSelection: boolean; canExplain: boolean }) => void;
}

/** 当前编辑器里「要分析的 SQL」：有选区取选区，否则取全文，并判断是否为查询语句 */
function editorQueryState(editor: monaco.editor.IStandaloneCodeEditor): { hasSelection: boolean; canExplain: boolean } {
  const selection = editor.getSelection();
  const hasSelection = Boolean(selection && !selection.isEmpty());
  const text = hasSelection && selection
    ? editor.getModel()?.getValueInRange(selection) ?? ""
    : editor.getValue();

  return { hasSelection, canExplain: isQuerySql(text) };
}

/**
 * Monaco 编辑器的生命周期：创建 / 选项同步 / 主题 / 内容与当前标签同步 /
 * 补全 Provider / 快捷键命令 / 空格标记块装饰。
 */
export function useMonacoEditor(options: UseMonacoEditorOptions) {
  const { settings, containerRef, suggestionContextRef, runShortcutRef, formatShortcutRef, saveShortcutRef, onContentChange, activeTab, editorPanelRef, resolveSql, onSelectionChange } = options;

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const suppressChange = useRef(false);
  /* 内容是在容器还不可见（0 高 / 收起）时写入的 → 需要等展开后补一次分词 */
  const needsRetokenize = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  useEffect(() => {
    const container = containerRef.current;

    if (!container || editorRef.current)
      return;

    const initial = settingsRef.current;

    /* create() 会把 Monaco 的全局主题设成这里传的值，冷启动深色时必须一开始就传对 */
    const resolvedTheme = resolveThemeMode(initial.theme);

    if (resolvedTheme === "dark")
      ensureGithubDarkTheme();

    const editor = monaco.editor.create(container, {
      value: DEFAULT_SQL,
      language: "sql",
      theme: resolvedTheme === "dark" ? "valkyrie-github-dark" : "vs",
      automaticLayout: true,
      /* 创建时就带上选项里的编辑器配置（不能写死：否则启动时要等选项变动才会生效） */
      minimap: { enabled: initial.editorMinimap },
      fontSize: initial.editorFontSize,
      lineHeight: Math.round(initial.editorFontSize * 1.45),
      fontFamily: resolveFontFamily(initial.editorFontFamily, "editor"),
      lineNumbers: initial.editorLineNumbers ? "on" : "off",
      tabSize: initial.editorTabSize,
      wordWrap: initial.editorWordWrap ? "on" : "off",
      /*
       * 空格 / 制表符的点与缩进参考线默认不画（选项里可开）：
       * Monaco 默认 renderWhitespace 是 "selection"，选中文本时缩进会冒出一排点，
       * 参考线也是默认开着的 —— 满屏的点和竖线太吵。
       */
      renderWhitespace: initial.editorWhitespace ? "all" : "none",
      guides: {
        indentation: initial.editorWhitespace,
        highlightActiveIndentation: initial.editorWhitespace
      },
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      /* 滚动条收细，和界面其它区域保持一致 */
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      renderLineHighlight: "line",
      /*
       * 关掉 Unicode 高亮检测：默认会把非 ASCII（中文、全角标点等）用黄色框标出来，
       * SQL 里写中文注释/字符串很正常，不需要这种提示。
       */
      unicodeHighlight: {
        nonBasicASCII: false,
        ambiguousCharacters: false,
        invisibleCharacters: false
      },
      /* 右键菜单换成 FX 版那套（自己接管），关掉 Monaco 内置的 */
      contextmenu: false,
      /* 补全走 Monaco 内置弹窗；候选由下面注册的 Provider 提供 */
      quickSuggestions: initial.suggestEnabled ? { other: true, comments: false, strings: false } : false,
      suggestOnTriggerCharacters: initial.suggestEnabled,
      wordBasedSuggestions: "off",
      suggest: { showWords: false, showSnippets: true, preview: true },
      padding: { top: 6 }
    });

    editor.onDidChangeModelContent(() => {
      if (suppressChange.current)
        return;

      onContentChangeRef.current(editor.getValue());
      /* 输入过程中首关键字可能刚好凑成查询语句，同步一次按钮可用态 */
      onSelectionChangeRef.current?.(editorQueryState(editor));
    });

    /*
     * 空白标记块：插进来的空格 / Tab 都用终端绿的块标出来（行首缩进的、字符后面接着敲的
     * 都算），一眼看得出敲了几个空白；一旦键入正文 / 换行 / 退格 / 移动光标就收掉 —— 空白本身留着。
     *
     * 只做渲染：按键全部交给 Monaco 自己处理（插入几个空格、怎么删、怎么缩进都不改），
     * 这里只观测「插进来的空白」并把它画成绿块。
     * 用装饰（decoration）而不是真选中：真选中会在打字时把缩进替换掉。
     * 与选中蓝块不抢地方：一旦出现真选区（拖选 / Ctrl+A / 双击选词）绿块就让位。
     */
    const indentMarks = editor.createDecorationsCollection([]);
    let indentMark: { anchor: number; end: number } | null = null;

    function clearIndentMark() {
      if (!indentMark)
        return;

      indentMark = null;
      indentMarks.clear();
    }

    function markIndent(anchor: number, end: number) {
      const model = editor.getModel();

      if (!model)
        return;

      indentMark = { anchor, end };
      indentMarks.set([{
        range: monaco.Range.fromPositions(model.getPositionAt(anchor), model.getPositionAt(end)),
        options: { className: "editor-indent-mark" }
      }]);
    }

    editor.onKeyDown(event => {
      if (event.keyCode === monaco.KeyCode.Enter || event.keyCode === monaco.KeyCode.Backspace
        || event.keyCode === monaco.KeyCode.Delete || event.keyCode === monaco.KeyCode.Escape
        || event.keyCode === monaco.KeyCode.LeftArrow || event.keyCode === monaco.KeyCode.RightArrow
        || event.keyCode === monaco.KeyCode.UpArrow || event.keyCode === monaco.KeyCode.DownArrow
        || event.keyCode === monaco.KeyCode.Home || event.keyCode === monaco.KeyCode.End)
        clearIndentMark();
    });

    /*
     * 观测文本改动：插进来的空白（Tab 或空格键，位置不限）→ 画成蓝块；
     * 其它改动（打字、粘贴、输入法、撤销、删除）→ 收掉蓝块。
     */
    editor.onDidChangeModelContent(event => {
      const model = editor.getModel();

      if (!model || event.changes.length !== 1) {
        clearIndentMark();
        return;
      }

      const change = event.changes[0];
      const start = change.rangeOffset;
      const end = start + change.text.length;
      const onlyWhitespace = change.text.length > 0 && /^[ \t]+$/.test(change.text);
      const selection = editor.getSelection();
      /* 光标就在插入内容的末尾（没有其它选区）才算"刚插进来的这段" */
      const atEnd = selection != null && selection.isEmpty() && model.getOffsetAt(selection.getEndPosition()) === end;

      if (onlyWhitespace && atEnd) {
        /* 挨着上次的块继续敲就并进去，否则新起一块 */
        const anchor = indentMark && indentMark.end === start ? indentMark.anchor : start;

        markIndent(anchor, end);
        return;
      }

      clearIndentMark();
    });

    editor.onMouseDown(() => clearIndentMark());
    editor.onDidBlurEditorWidget(() => clearIndentMark());

    /*
     * 出现真选区（拖选 / Ctrl+A / 双击选词）就让位：
     * 绿块画在装饰层，压在选中蓝块上会互相糊成一块，分不清哪个是哪个。
     */
    editor.onDidChangeCursorSelection(event => {
      if (!event.selection.isEmpty())
        clearIndentMark();

      /* 选区变化会影响「执行计划」按钮的可用态（选中的不是查询语句就禁用） */
      onSelectionChangeRef.current?.(editorQueryState(editor));
    });

    const completionProvider = registerCompletionProvider(() => suggestionContextRef.current);

    /*
     * 快捷键命令必须通过 ref 取「当前」的处理函数：这个 effect 只在挂载时跑一次，
     * 直接调用组件内的函数会闭包在首次渲染的状态上（那时 activeTab 还是 null，
     * 于是 Ctrl+S / Ctrl+Enter 都会静默返回）。
     */
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runShortcutRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => formatShortcutRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveShortcutRef.current(false));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => saveShortcutRef.current(true));

    /* Ctrl/Cmd + W：智能扩选（按语法单元逐层扩大选区），Shift 版本收缩 */
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () =>
      editor.trigger("keyboard", "editor.action.smartSelect.expand", null));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyW, () =>
      editor.trigger("keyboard", "editor.action.smartSelect.shrink", null));

    /*
     * 容器从 0 高 / 收起切到可见时补一次分词：
     * Monaco 按「写入内容那一刻的可见范围」分词，若那时容器只有几像素高，
     * 之后 automaticLayout 只会重排视口，不会补分词，整段 SQL 就一直是默认色，
     * 非要滚动或重新输入才恢复。等容器长起来后按可见行强制分词即可。
     */
    let retokenizeRaf = 0;
    const containerObserver = new ResizeObserver(() => {
      const model = editor.getModel();

      if (!needsRetokenize.current || !model || container.clientHeight === 0)
        return;

      needsRetokenize.current = false;
      /* 等 automaticLayout 先把视口摆到位，再按可见范围分词 */
      retokenizeRaf = requestAnimationFrame(() => {
        if (model.isDisposed())
          return;

        const ranges = editor.getVisibleRanges();
        const lastLine = ranges.length > 0 ? ranges[ranges.length - 1].endLineNumber : model.getLineCount();

        /*
         * ITextModel 的公开类型没有暴露 tokenization；强制分词只有这一个入口，
         * Monaco 0.52 内部（TextModel.tokenization）就是靠它补齐懒分词。
         */
        (model as monaco.editor.ITextModel & {
          tokenization: { forceTokenization: (lineNumber: number) => void };
        }).tokenization.forceTokenization(lastLine);
      });
    });

    containerObserver.observe(container);
    editorRef.current = editor;

    return () => {
      cancelAnimationFrame(retokenizeRaf);
      containerObserver.disconnect();
      completionProvider.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 选项里的编辑器配置：声明在创建之后。
   * 挂载时先创建（带上当前选项），随后启动读盘校准的设置若与首屏不同，
   * 这个 effect 会因为依赖变化再应用一次。
   */
  useEffect(() => {
    const editor = editorRef.current;

    if (!editor)
      return;

    editor.updateOptions({
      fontSize: settings.editorFontSize,
      lineHeight: Math.round(settings.editorFontSize * 1.45),
      fontFamily: resolveFontFamily(settings.editorFontFamily, "editor"),
      wordWrap: settings.editorWordWrap ? "on" : "off",
      lineNumbers: settings.editorLineNumbers ? "on" : "off",
      tabSize: settings.editorTabSize,
      renderWhitespace: settings.editorWhitespace ? "all" : "none",
      guides: {
        indentation: settings.editorWhitespace,
        highlightActiveIndentation: settings.editorWhitespace
      },
      minimap: { enabled: settings.editorMinimap },
      quickSuggestions: settings.suggestEnabled ? { other: true, comments: false, strings: false } : false,
      suggestOnTriggerCharacters: settings.suggestEnabled
    });
    editor.layout();
  }, [
    settings.editorFontSize, settings.editorFontFamily, settings.editorWordWrap, settings.suggestEnabled,
    settings.editorLineNumbers, settings.editorTabSize, settings.editorMinimap, settings.editorWhitespace
  ]);

  /* 编辑器内容与当前标签同步 */
  useEffect(() => {
    /*
     * 非查询页把编辑器面板收起来（Monaco 实例仍常驻，不销毁）；
     * 回到查询页则展开回「最近一次的高度」——默认就是 80/20。
     */
    const panel = editorPanelRef.current;

    if (!panel)
      return;

    if (activeTab?.kind !== "query") {
      panel.collapse();
      return;
    }

    /* 展开回最近一次的高度（不会覆盖用户手动拖过的比例） */
    if (panel.isCollapsed())
      panel.expand();
  }, [activeTab?.kind, editorPanelRef]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor)
      return;

    /* 内容可能还停在 draft ref（未同步进 tabs 状态），这里取最新值，避免切回来被旧值覆盖 */
    const sql = activeTab && activeTab.kind === "query"
      ? (resolveSql ? resolveSql(activeTab) : activeTab.sql)
      : "";

    if (editor.getValue() !== sql) {
      suppressChange.current = true;
      editor.setValue(sql);
      suppressChange.current = false;
      /*
       * setValue 时容器若还是 0 高 / 收起，Monaco 只按当时的可见行分词；
       * 交给 ResizeObserver 在容器展开后补分词（见上面的 containerObserver）。
       */
      needsRetokenize.current = true;
    }

    if (activeTab?.kind === "query")
      editor.layout();

    /* 切标签 / 换内容后同步一次「执行计划」按钮可用态 */
    onSelectionChangeRef.current?.(editorQueryState(editor));
  }, [activeTab]);

  return { editorRef, suppressChange };
}
