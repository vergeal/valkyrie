import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "./editor.worker?worker";
import {
  chooseSavePath,
  invoke,
  messageOf,
  onEvent,
  onShortcut,
  onWindowState,
  revealPath,
  setNativeTheme,
  showMessage,
  windowControl,
  type OpenConnectionPayload,
  type ProductMeta,
  type ProgressEvent,
  type QueryColumn,
  type QueryResultPayload,
  type SavedConnection,
  type SchemaNode,
  type ScriptFile,
  type SuggestionItem,
  type TableColumn,
  type TableIndex
} from "./api";
import { Tree } from "./ui/Tree";
import { ResultGrid } from "./ui/ResultGrid";
import { ObjectInfo } from "./ui/ObjectInfo";
import { TableDesign } from "./ui/TableDesign";
import { TableList } from "./ui/TableList";
import { ScriptList } from "./ui/ScriptList";
import { ConnectionDialog } from "./ui/ConnectionDialog";
import { ConnectionManager } from "./ui/ConnectionManager";
import { Dialog } from "./ui/Dialog";
import { MenuButton, popupNativeMenu, type MenuEntry } from "./ui/Menu";
import { OptionsDialog } from "./ui/OptionsDialog";
import { Select } from "./ui/Select";
import { Icon } from "./ui/icons";
import { LogConsole, appendLog, errorRecord, progressRecord, type LogRecord } from "./ui/LogConsole";
import { loadSettings, saveSettings, type AppSettings } from "./settings";
import { ACCEL, IS_MAC, KEY } from "./keys";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Toaster, toast } from "sonner";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

/**
 * 深色主题的 Monaco 配色：对齐 GitHub Dark 的 token 颜色
 * （注释灰、关键字红、字符串浅蓝、数字 / 常量蓝、类型橙），编辑器底色 #0d1117。
 * 只在首次切到深色时注册一次。
 */
let githubDarkReady = false;

function ensureGithubDarkTheme() {
  if (githubDarkReady)
    return;

  monaco.editor.defineTheme("valkyrie-github-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "c9d1d9", background: "0d1117" },
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "keyword", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "number", foreground: "79c0ff" },
      { token: "operator", foreground: "ff7b72" },
      { token: "delimiter", foreground: "c9d1d9" },
      { token: "identifier", foreground: "c9d1d9" },
      { token: "predefined", foreground: "79c0ff" },
      { token: "type", foreground: "ffa657" },
      { token: "variable", foreground: "ffa657" }
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

const DEFAULT_SQL = "";

type ThemeMode = "light" | "dark" | "system";

const NEXT_THEME: Record<ThemeMode, ThemeMode> = { light: "dark", dark: "system", system: "light" };
const THEME_LABEL: Record<ThemeMode, string> = { light: "浅色", dark: "深色", system: "跟随系统" };
const THEME_ICON: Record<ThemeMode, string> = { light: "sun", dark: "moon", system: "system" };

interface SessionState {
  sessionId: string;
  name: string;
  product: ProductMeta;
}

interface BaseTab {
  id: string;
  title: string;
  running: boolean;
  messages: string[];
  /** 本次未提交的改动条数（编辑/新增/删除/设 NULL 累计），提交/回滚后清零 */
  pending?: number;
}

interface QueryTab extends BaseTab {
  kind: "query";
  sql: string;
  /** 上次保存到磁盘的内容；与 sql 不一致说明有未保存修改 */
  savedSql?: string;
  result: QueryResultPayload | null;
  plan: QueryResultPayload | null;
  dirtyRows: number[];
  /* 绑定到本地查询脚本文件时才有 */
  script?: { connection: string; catalog: string; name: string };
  /* 执行上下文：连接 → 数据库 → 模式 → 表 */
  path: { connection?: string; catalog?: string; schema?: string; table?: string };
}

interface DataTab extends BaseTab {
  kind: "data";
  node: SchemaNode;
  result: QueryResultPayload | null;
  dirtyRows: number[];
  page: number;
  pageSize: number;
}

interface DesignTab extends BaseTab {
  kind: "design";
  node: SchemaNode;
  columns: TableColumn[];
  indexes: TableIndex[];
  ddl: string;
  loading: boolean;
}

/**
 * 「对象」列：属于当前连接的一个固定页面，内容跟着对象树的选中项走 ——
 * 选中库 / 表 → 数据表列表，选中脚本 → 脚本列表；断开连接时一起关闭。
 */
interface ObjectTabTables extends BaseTab {
  kind: "objects";
  view: "tables";
  /* 数据表列表所属的「数据表」容器节点 */
  node: SchemaNode;
  tables: SchemaNode[];
  scripts: ScriptFile[];
  loading: boolean;
}

interface ObjectTabScripts extends BaseTab {
  kind: "objects";
  view: "scripts";
  node: null;
  tables: SchemaNode[];
  scripts: ScriptFile[];
  loading: boolean;
}

type ObjectTab = ObjectTabTables | ObjectTabScripts;

type WorkTab = QueryTab | DataTab | DesignTab | ObjectTab;

/* 对象列的标签标题固定，不写成「xxx 对象」 */
const OBJECT_TAB_TITLE = "对象";

type ResultPane = "grid" | "msg" | "plan" | "log";

let tabSequence = 1;

function newQueryTab(): QueryTab {
  return {
    id: `tab-${tabSequence++}`,
    kind: "query",
    title: `查询控制台 ${tabSequence - 1}`,
    running: false,
    messages: [],
    sql: DEFAULT_SQL,
    result: null,
    plan: null,
    dirtyRows: [],
    path: {}
  };
}

export function App() {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [roots, setRoots] = useState<SchemaNode[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, SchemaNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["conn-root"]));
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [activeNode, setActiveNode] = useState<SchemaNode | null>(null);
  const [infoColumns, setInfoColumns] = useState<TableColumn[]>([]);
  const [infoIndexes, setInfoIndexes] = useState<TableIndex[]>([]);

  /* 启动时不预置标签，关闭后也不会自动补一个 */
  const [tabs, setTabs] = useState<WorkTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [resultPane, setResultPane] = useState<ResultPane>("grid");
  const [treeFilter, setTreeFilter] = useState("");
  const [catalogOptions, setCatalogOptions] = useState<SchemaNode[]>([]);
  const [schemaOptions, setSchemaOptions] = useState<SchemaNode[]>([]);
  /* 当前数据库/模式下的全部表，供工具栏「表」下拉与智能提示使用 */
  const [tableNodes, setTableNodes] = useState<SchemaNode[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    danger: boolean;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const [connectionDialog, setConnectionDialog] = useState<{
    mode: "new" | "edit" | "copy";
    connection?: SavedConnection | null;
  } | null>(null);
  const [messageBox, setMessageBox] = useState<{ title: string; message: string } | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSide, setShowSide] = useState(true);
  const [showInfo, setShowInfo] = useState(true);
  const [gridSelection, setGridSelection] = useState<{
    r1: number; r2: number; c1: number; c2: number;
    row: number; col: number; rows: number; cols: number;
    /** 选区里真正可见的行 / 列下标（搜索过滤时排除被隐藏的行） */
    rowList: number[]; colList: number[];
  } | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  /* 「脚本」页：过滤词、选中项（按脚本绝对路径）、刷新闪烁 */
  const [scriptFilter, setScriptFilter] = useState("");
  const [scriptSelection, setScriptSelection] = useState<string[]>([]);
  const [scriptFlash, setScriptFlash] = useState(0);
  /* 「连接管理」窗口 */
  const [managerOpen, setManagerOpen] = useState(false);
  /* 结果集全表搜索：输入值 / 防抖后的关键字（同 FX 版，停顿一下再过滤） */
  const [gridSearch, setGridSearch] = useState("");
  const [gridKeyword, setGridKeyword] = useState("");
  /* 命中行数（null = 未搜索），显示在结果集工具条上 */
  const [gridHits, setGridHits] = useState<number | null>(null);
  /* 「对象」页选中的行（按表名匹配：树与列表分属两次查询，节点 id 不同；支持多选） */
  const [tableSelection, setTableSelection] = useState<string[]>([]);
  /* 刷新反馈：不弹提示，改成表格闪一下（计数变化即触发动画） */
  const [gridFlash, setGridFlash] = useState(0);
  const [listFlash, setListFlash] = useState(0);
  const [textDialog, setTextDialog] = useState<{
    title: string;
    value: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [busy, setBusy] = useState(0);
  /* 正在执行的动作（按钮名），用于给按钮本身加加载态 */
  const [pending, setPending] = useState<string | null>(null);

  /* 操作反馈：浮层提示（sonner）+ 状态栏转圈，让用户知道动作确实执行了 */
  function flash(text: string) {
    toast.success(text);
  }

  async function withBusy<T>(action: () => Promise<T>): Promise<T> {
    setBusy(value => value + 1);
    try {
      return await action();
    } finally {
      setBusy(value => value - 1);
    }
  }

  function askText(title: string, value = ""): Promise<string | null> {
    return new Promise(resolve => setTextDialog({ title, value, resolve }));
  }

  function answerText(value: string | null) {
    textDialog?.resolve(value);
    setTextDialog(null);
  }

  function askConfirm(message: string, title = "确认", danger = false): Promise<boolean> {
    return new Promise(resolve => setConfirmDialog({ message, title, danger, resolve }));
  }

  function answerConfirm(confirmed: boolean) {
    confirmDialog?.resolve(confirmed);
    setConfirmDialog(null);
  }

  const [status, setStatus] = useState("就绪");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [maximized, setMaximized] = useState(false);
  /* 客户端配置（选项对话框里改，改完立即生效并落盘） */
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [optionsOpen, setOptionsOpen] = useState(false);

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings(previous => {
      const next = { ...previous, ...patch };
      saveSettings(next);
      return next;
    });
  }

  /* 三栏与「编辑器 / 结果」两段布局交给 react-resizable-panels（自带记忆与最小尺寸） */
  /*
   * onlySaveAfterUserInteractions：程序自己做的收起/展开（切换标签时）不写进记忆，
   * 否则"没开标签时编辑器收起"会被存下来，之后打开查询就恢复成被压缩的高度。
   */
  const columnsLayout = useDefaultLayout({
    id: "valkyrie.layout.columns",
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true
  });
  const rowsLayout = useDefaultLayout({
    id: "valkyrie.layout.rows-v4",
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true
  });
  const editorPanelRef = usePanelRef();

  /* 旧版记住的「结果区很高」布局会让默认值不生效，这里清一次让它回到新默认 */
  useEffect(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.includes("valkyrie.layout.rows") && !key.includes("rows-v4"))
        window.localStorage.removeItem(key);
    }
  }, []);

  const [error, setError] = useState<string | null>(null);
  /* 语句执行报错写进日志面板（见上方 onEvent / runQuery），不再占用工作区顶部 */
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [lastCost, setLastCost] = useState<number | null>(null);

  /* 错误提示走系统原生消息框（不是网页弹层） */
  useEffect(() => {
    if (!error)
      return;

    void showMessage({
      type: "error",
      title: "出错了",
      message: error,
      buttons: ["确定"]
    });
  }, [error]);

  const editorContainer = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const suppressChange = useRef(false);
  const activeTabRef = useRef(activeTabId);
  const jobTabRef = useRef<Map<number, string>>(new Map());
  const runningJobRef = useRef<Map<string, number>>(new Map());
  const suggestionContextRef = useRef<{
    sessionId?: string;
    connection?: string;
    catalog?: string;
    schema?: string;
    type?: string;
  }>({});
  /* 断开连接后仍要能提示：记住最近一次连接的连接名与数据库类型 */
  const lastSessionRef = useRef<{ name?: string; type: string }>({ type: "mysql" });
  /* 用 ref 保存当前会话，避免异步回调里拿到已失效的 sessionId */
  const sessionRef = useRef<SessionState | null>(null);

  activeTabRef.current = activeTabId;
  sessionRef.current = session;

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null;

  /* ------------------------------ 初始化 ------------------------------ */

  useEffect(() => {
    void refreshConnections();

    return onEvent((event: ProgressEvent) => {
      if (event.channel !== "query.progress")
        return;

      const line = formatProgress(event);
      const record = progressRecord(event);

      if (!line || !record)
        return;

      if (event.kind === "cost" && event.detail)
        setLastCost(Number(event.detail));

      setLogs(previous => appendLog(previous, record));

      const tabId = event.jobId != null ? jobTabRef.current.get(event.jobId) : undefined;

      if (tabId)
        setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, messages: [...tab.messages, line] } : tab));
    });
  }, []);

  useEffect(() => {
    return onWindowState(state => setMaximized(state.maximized));
  }, []);

  /* 主题：默认浅色（与设计稿一致），不跟随 Windows 深色模式 */
  useEffect(() => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;

    document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;

    /* 深色用 GitHub Dark 配色，浅色保持 Monaco 默认的 vs */
    if (resolved === "dark")
      ensureGithubDarkTheme();

    monaco.editor.setTheme(resolved === "dark" ? "valkyrie-github-dark" : "vs");
    /* 系统原生菜单 / 对话框也跟随应用主题 */
    void setNativeTheme(theme);
  }, [theme]);

  /* 选项：界面字号 / 表格字号用 CSS 变量驱动，改完即时生效 */
  useEffect(() => {
    const root = document.documentElement.style;

    root.setProperty("--ui-font-size", `${settings.uiFontSize}px`);
    root.setProperty("--grid-font-size", `${settings.gridFontSize}px`);
  }, [settings.uiFontSize, settings.gridFontSize]);

  /* 选项：编辑器字号 / 自动换行 / 智能提示 */
  useEffect(() => {
    const editor = editorRef.current;

    if (!editor)
      return;

    editor.updateOptions({
      fontSize: settings.editorFontSize,
      lineHeight: Math.round(settings.editorFontSize * 1.45),
      wordWrap: settings.editorWordWrap ? "on" : "off",
      quickSuggestions: settings.suggestEnabled ? { other: true, comments: false, strings: false } : false,
      suggestOnTriggerCharacters: settings.suggestEnabled
    });
  }, [settings.editorFontSize, settings.editorWordWrap, settings.suggestEnabled]);

  useEffect(() => {
    if (!editorContainer.current || editorRef.current)
      return;

    const editor = monaco.editor.create(editorContainer.current, {
      value: DEFAULT_SQL,
      language: "sql",
      theme: "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      lineHeight: 20,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      /* 滚动条收细，和界面其它区域保持一致 */
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      renderLineHighlight: "line",
      /* 右键菜单换成 FX 版那套（自己接管），关掉 Monaco 内置的 */
      contextmenu: false,
      /* 补全走 Monaco 内置弹窗；候选由下面注册的 Provider 提供 */
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "off",
      suggest: { showWords: false, showSnippets: true, preview: true },
      padding: { top: 6 }
    });

    editor.onDidChangeModelContent(() => {
      if (suppressChange.current)
        return;

      const tabId = activeTabRef.current;

      setTabs(previous => previous.map(tab =>
        tab.id === tabId && tab.kind === "query" ? { ...tab, sql: editor.getValue() } : tab));
    });

    /* SQL 智能提示：候选项来自 Java 侧上下文引擎，过滤/排序交给 Monaco */
    const completionProvider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: [" ", "."],
      provideCompletionItems: async (model, position) => {
        const context = suggestionContextRef.current;

        /* 没有会话也还有该方言的关键字提示（连接关闭后的情况） */
        if (!context.sessionId && !context.type)
          return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

        try {
          const payload = await invoke<{ suggestions: SuggestionItem[] }>("sql.suggest", {
            sessionId: context.sessionId,
            connection: context.connection,
            type: context.type,
            catalog: context.catalog,
            schema: context.schema,
            sql: model.getValue(),
            offset: model.getOffsetAt(position)
          });

          return {
            suggestions: (payload.suggestions ?? []).map(item => ({
              label: item.label,
              kind: completionKind(item.kind),
              detail: item.detail || undefined,
              insertText: item.insertText ?? item.label,
              /* 片段交给 Monaco 展开 ${1:...} 占位符 */
              insertTextRules: item.kind === "Snippet"
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              range
            }))
          };
        } catch {
          return { suggestions: [] };
        }
      }
    });

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

    editorRef.current = editor;

    return () => {
      completionProvider.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

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
  }, [activeTab?.kind]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor)
      return;

    const sql = activeTab && activeTab.kind === "query" ? activeTab.sql : "";

    if (editor.getValue() !== sql) {
      suppressChange.current = true;
      editor.setValue(sql);
      suppressChange.current = false;
    }

    if (activeTab?.kind === "query")
      editor.layout();
  }, [activeTab]);

  /* 选中表对象时加载结构与索引 */
  useEffect(() => {
    let cancelled = false;

    if (!session || !activeNode || activeNode.kind !== "TABLE" || !activeNode.table) {
      setInfoColumns([]);
      setInfoIndexes([]);
      return;
    }

    const params = tableParams(session.sessionId, activeNode);

    void Promise.all([
      invoke<{ columns: TableColumn[] }>("table.columns", params),
      invoke<{ indexes: TableIndex[] }>("table.indexes", params)
    ]).then(([columns, indexes]) => {
      if (cancelled)
        return;

      setInfoColumns(columns.columns);
      setInfoIndexes(indexes.indexes);
    }).catch(() => {
      if (!cancelled) {
        setInfoColumns([]);
        setInfoIndexes([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeNode, session]);

  /* ------------------------------ 执行上下文选择器 ------------------------------ */

  const activeCatalog = activeTab?.kind === "query" ? activeTab.path.catalog : undefined;
  const activeSchema = activeTab?.kind === "query" ? activeTab.path.schema : undefined;

  /*
   * 补全上下文：
   * - 有会话时带 sessionId，数据层给「关键字 + 本库表名 + 引用表的字段」，
   *   同时按连接名留一份元数据快照；
   * - 连接已关闭时改带连接名，数据层用那份快照继续提示表名 / 字段（内容是断开前的），
   *   快照也没有（比如从没在这个连接上敲过字）才退化成该方言的关键字。
   */
  suggestionContextRef.current = {
    sessionId: session?.sessionId,
    connection: session?.name ?? consoleConnection(),
    /* 查询页没显式选库时按当前连接的第一个库取元数据，保证提示里有表与字段 */
    catalog: activeCatalog ?? catalogOptions[0]?.label,
    schema: activeSchema,
    type: session ? undefined : suggestionType()
  };

  /**
   * 当前查询控制台属于哪个连接：优先用标签自己记的（断开后仍在），
   * 再看它绑定的脚本，最后退回最近一次连接过的连接名。
   */
  function consoleConnection(): string | undefined {
    if (activeTab?.kind !== "query")
      return lastSessionRef.current.name;

    return activeTab.path.connection ?? activeTab.script?.connection ?? lastSessionRef.current.name;
  }

  /** 没有活动会话时补全用的数据库类型：同上看连接，再退回最近连接过的类型 */
  function suggestionType(): string {
    const name = consoleConnection();
    const found = name ? connections.find(item => item.name === name)?.type : undefined;

    return found ?? lastSessionRef.current.type;
  }

  /*
   * 进入查询页（或切库 / 切模式）时预热该上下文的补全引擎：
   * 数据层顺手留下元数据快照，之后断开连接仍然能提示表名与字段。
   */
  const warmPath = activeTab?.kind === "query" ? activeTab.path : undefined;

  useEffect(() => {
    if (!session || !warmPath)
      return;

    void invoke("sql.warmSuggest", {
      sessionId: session.sessionId,
      catalog: warmPath.catalog ?? catalogOptions[0]?.label,
      schema: warmPath.schema
    }).catch(() => undefined);
  }, [session?.sessionId, activeTab?.id, warmPath?.catalog, warmPath?.schema, catalogOptions]);

  /* 连接后把根节点作为「数据库」候选，并给查询页一个默认上下文 */
  useEffect(() => {
    setCatalogOptions(roots);

    if (roots.length === 0)
      return;

    setTabs(previous => previous.map(tab =>
      tab.kind === "query" && !tab.path.catalog
        ? { ...tab, path: { ...tab.path, catalog: roots[0].label } }
        : tab));
  }, [roots]);

  /* 切换数据库：加载模式列表与表列表 */
  useEffect(() => {
    if (!session || !activeCatalog) {
      setSchemaOptions([]);
      setTableNodes([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      const catalogNode = roots.find(node => node.label === activeCatalog);

      if (!catalogNode)
        return;

      const children = await loadChildren(session.sessionId, catalogNode);

      if (cancelled)
        return;

      const schemas = children.filter(node => node.kind === "SCHEMA");
      setSchemaOptions(schemas);

      /* MySQL 这类没有模式层级：表直接挂在数据库下的「数据表」容器里 */
      const container = children.find(node => node.kind === "TABLE" && node.hasChildren);

      if (schemas.length === 0 && container) {
        const tables = await loadChildren(session.sessionId, container);

        if (!cancelled)
          setTableNodes(tables.filter(node => node.kind === "TABLE" && !node.hasChildren));
      } else if (!cancelled) {
        setTableNodes([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, activeCatalog, roots]);

  /* 切换模式：加载该模式下的表 */
  useEffect(() => {
    /* 没有模式层级时由上面那个 effect 负责表列表 */
    if (!session || !activeSchema)
      return;

    let cancelled = false;

    void (async () => {
      const schemaNode = schemaOptions.find(node => node.label === activeSchema);

      if (!schemaNode)
        return;

      const children = await loadChildren(session.sessionId, schemaNode);

      if (cancelled)
        return;

      const container = children.find(node => node.kind === "TABLE" && node.hasChildren);

      if (!container) {
        setTableNodes([]);
        return;
      }

      const tables = await loadChildren(session.sessionId, container);

      if (!cancelled)
        setTableNodes(tables.filter(node => node.kind === "TABLE" && !node.hasChildren));
    })();

    return () => {
      cancelled = true;
    };
  }, [session, activeSchema, schemaOptions]);

  /* ------------------------------ 数据层 ------------------------------ */

  async function refreshConnections() {
    setPending("connections");

    try {
      const payload = await withBusy(() => invoke<{ connections: SavedConnection[] }>("connections.list"));
      setConnections(payload.connections);
      setStatus("连接列表已刷新");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  }

  async function openConnection(connection: SavedConnection) {
    setError(null);
    setStatus(`正在连接 ${connection.name} …`);

    /* 换连接会清掉当前会话：先把没保存的内容问清楚 */
    if (session && session.name !== connection.name) {
      const unsaved = tabs.filter(hasUnsaved);

      if (unsaved.length > 0) {
        const confirmed = await askConfirm(
          `连接 ${session.name} 上还有没保存的内容：\n${unsaved.map(describeUnsaved).join("\n")}\n\n切到 ${connection.name} 会丢失这些改动，确定继续吗？`,
          "未保存的修改",
          true
        );

        if (!confirmed)
          return false;
      }
    }

    /* 连接期间在对应节点上显示加载动画 */
    const nodeId = `conn:${connection.name}`;

    setLoadingNodes(previous => new Set(previous).add(nodeId));

    try {
      if (session)
        await invoke("connection.close", { sessionId: session.sessionId }).catch(() => undefined);

      const opened = await withBusy(() => invoke<OpenConnectionPayload>("connection.open", { name: connection.name }));

      setSession({ sessionId: opened.sessionId, name: connection.name, product: opened.product });
      lastSessionRef.current = {
        name: connection.name,
        type: connection.type ?? opened.product.type ?? lastSessionRef.current.type
      };
      setRoots(opened.nodes);
      setChildrenMap({});
      setActiveNode(null);
      setStatus(`已连接 ${connection.name}`);

      /* 只展开连接节点本身，数据库/表等子节点保持收起，由用户按需展开 */
      setExpanded(previous => new Set(previous).add(`conn:${connection.name}`));
      return true;
    } catch (e) {
      setError(messageOf(e));
      setStatus("连接失败");
      return false;
    } finally {
      setLoadingNodes(previous => {
        const next = new Set(previous);
        next.delete(nodeId);
        return next;
      });
    }
  }

  async function loadChildren(sessionId: string, node: SchemaNode, force = false): Promise<SchemaNode[]> {
    /* 已经加载过就直接复用：数据层每次返回的节点 id 都是新的，
       重复加载会让已展开的子节点对不上 id 而消失 */
    const cached = childrenMap[node.id];

    if (cached && !force)
      return cached;

    setLoadingNodes(previous => new Set(previous).add(node.id));

    try {
      const payload = await invoke<{ nodes: SchemaNode[] }>("schema.children", {
        sessionId,
        nodeId: node.id
      });

      /* 把 catalog / schema 继承给子节点，便于后续分页、取表结构 */
      const children = payload.nodes.map(child => ({
        ...child,
        catalog: child.catalog ?? node.catalog ?? (node.kind === "CATALOG" ? node.label : undefined),
        schema: child.schema ?? node.schema ?? (node.kind === "SCHEMA" ? node.label : undefined)
      }));

      setChildrenMap(previous => ({ ...previous, [node.id]: children }));

      return children;
    } catch (e) {
      setError(messageOf(e));
      return [];
    } finally {
      setLoadingNodes(previous => {
        const next = new Set(previous);
        next.delete(node.id);
        return next;
      });
    }
  }

  async function toggleNode(node: SchemaNode) {
    if (node.kind === "ROOT" || (node.kind === "CONNECTION" && node.connected)) {
      setExpanded(previous => {
        const next = new Set(previous);

        if (next.has(node.id))
          next.delete(node.id);
        else
          next.add(node.id);

        return next;
      });
      return;
    }

    /* 未连接的连接节点：点击即建立连接 */
    if (node.kind === "CONNECTION") {
      const connection = connections.find(item => item.name === node.label);

      if (!connection)
        return;

      await openConnection(connection);
      setExpanded(previous => new Set(previous).add(node.id));
      return;
    }

    if (!node.hasChildren || !session)
      return;

    if (expanded.has(node.id)) {
      /* 收起节点：连带关闭它下面打开的数据页 / 表设计页 */
      closeTabsUnder(node);

      setExpanded(previous => {
        const next = new Set(previous);
        next.delete(node.id);
        return next;
      });
      return;
    }

    setExpanded(previous => new Set(previous).add(node.id));

    if (childrenMap[node.id] || loadingNodes.has(node.id))
      return;

    await loadChildren(session.sessionId, node);
  }

  /**
   * 关闭某个树节点下打开的标签页：
   * 连接 → 它的全部数据/设计页；数据库 → 该库下的；模式 → 该模式下的；表容器/表 → 对应的表。
   * 查询控制台与常驻的「对象」页不受影响。
   */
  function closeTabsUnder(node: SchemaNode) {
    const shouldClose = (tab: WorkTab) => {
      if (tab.kind !== "data" && tab.kind !== "design")
        return false;

      const target = tab.node;

      if (node.kind === "CONNECTION")
        return true;

      if (node.kind === "CATALOG")
        return target.catalog === (node.catalog ?? node.label);

      if (node.kind === "SCHEMA")
        return target.catalog === node.catalog && target.schema === node.label;

      if (node.kind === "TABLE" && node.hasChildren)
        return target.catalog === node.catalog && target.schema === node.schema;

      if (node.kind === "TABLE")
        return target.label === node.label && target.catalog === node.catalog;

      return false;
    };

    const next = tabs.filter(tab => !shouldClose(tab));

    if (next.length === tabs.length)
      return;

    setTabs(next);

    if (!next.some(tab => tab.id === activeTabId))
      setActiveTabId(next[next.length - 1]?.id ?? "");
  }

  /* ------------------------------ 标签页 ------------------------------ */

  function updateTab(id: string, patch: Partial<WorkTab>) {
    setTabs(previous => previous.map(tab => tab.id === id ? { ...tab, ...patch } as WorkTab : tab));
  }

  function createQueryTab() {
    void openQueryTab();
  }

  /**
   * 新建查询：执行上下文跟随对象树里当前选中的节点
   * （选中哪个连接 / 数据库 / 模式 / 表，就用哪个；选中的连接不是当前会话时先切过去）
   */
  async function openQueryTab() {
    const context = selectionContext();
    const target = context.connection
      ? connections.find(item => item.name === context.connection)
      : undefined;

    if (target && target.name !== session?.name) {
      const opened = await openConnection(target);

      if (!opened)
        return;
    }

    const tab = newQueryTab();
    /* 记住这个控制台属于哪个连接：断开连接后补全靠它的快照 */
    tab.path = { connection: context.connection, catalog: context.catalog, schema: context.schema };

    setTabs(previous => [...previous, tab]);
    setActiveTabId(tab.id);
    setResultPane("grid");

    return tab;
  }

  /* 按 id 在对象树里找节点 / 找父节点（树只缓存已加载的层级） */
  function findTreeNode(id: string): SchemaNode | null {
    if (treeRoot.id === id)
      return treeRoot;

    for (const children of Object.values(treeChildren))
      for (const child of children)
        if (child.id === id)
          return child;

    return null;
  }

  function parentTreeNode(id: string): SchemaNode | null {
    const entry = Object.entries(treeChildren).find(([, children]) => children.some(child => child.id === id));
    return entry ? findTreeNode(entry[0]) : null;
  }

  /** 选中节点 → 执行上下文：连接名 + 数据库 + 模式 */
  function selectionContext(): { connection?: string; catalog?: string; schema?: string } {
    const fallbackCatalog = catalogOptions[0]?.label;

    if (!activeNode)
      return { catalog: fallbackCatalog };

    let connection: string | undefined;

    for (let node: SchemaNode | null = activeNode, guard = 0; node && guard < 16; guard++) {
      if (node.kind === "CONNECTION") {
        connection = node.label;
        break;
      }

      node = parentTreeNode(node.id);
    }

    const catalog = activeNode.kind === "CATALOG" ? activeNode.label : activeNode.catalog ?? fallbackCatalog;
    const schema = activeNode.kind === "SCHEMA" ? activeNode.label : activeNode.schema;

    return { connection, catalog, schema };
  }

  /** 关闭标签：当前 / 左侧 / 右侧 / 全部（有没保存的脚本时先确认） */
  async function closeTabs(mode: "current" | "left" | "right" | "all", id: string) {
    const index = tabs.findIndex(tab => tab.id === id);

    if (index < 0)
      return;

    /* 对象列是常驻页：不能被关闭，也不会被"关闭左侧/右侧/全部"带走（断连时随连接一起收走） */
    if (mode === "current" && tabs[index].kind === "objects")
      return;

    const keep = mode === "current"
      ? (tab: WorkTab) => tab.id !== id
      : mode === "left"
        ? (_tab: WorkTab, position: number) => position >= index
        : mode === "right"
          ? (_tab: WorkTab, position: number) => position <= index
          : () => false;

    const kept = (tab: WorkTab, position: number) => tab.kind === "objects" || keep(tab, position);
    const closing = tabs.filter((tab, position) => !kept(tab, position));
    const unsaved = closing.filter(hasUnsaved);

    if (unsaved.length > 0) {
      const confirmed = await askConfirm(
        `以下标签还有没保存的内容：\n${unsaved.map(describeUnsaved).join("\n")}\n\n关闭后改动会丢失，确定关闭吗？`,
        "未保存的修改",
        true
      );

      if (!confirmed)
        return;
    }

    const next = tabs.filter((tab, position) => kept(tab, position));

    setTabs(next);

    if (!next.some(tab => tab.id === activeTabId))
      setActiveTabId(next[Math.min(index, next.length - 1)]?.id ?? "");
  }

  function closeTab(id: string) {
    void closeTabs("current", id);
  }

  function openTableData(node: SchemaNode) {
    if (!node.table)
      return;

    /* 同名表可能出现在不同库 / 模式下，必须带上上下文一起比较 */
    const existing = tabs.find(tab =>
      tab.kind === "data"
      && tab.node.table?.name === node.table?.name
      && tab.node.catalog === node.catalog
      && tab.node.schema === node.schema);

    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const tab: DataTab = {
      id: `tab-${tabSequence++}`,
      kind: "data",
      title: node.label,
      running: false,
      messages: [],
      node,
      result: null,
      dirtyRows: [],
      page: 0,
      pageSize: settings.pageSize
    };

    setTabs(previous => [...previous, tab]);
    setActiveTabId(tab.id);
    void loadPage(tab.id, node, 0, settings.pageSize);
  }

  /**
   * 对象树里选中节点 → 记住当前节点，并让「对象」列跟着走：
   * 库 / 表 → 数据表列表（选中哪个表就高亮哪个），脚本 → 脚本列表；
   * 连接与根节点不联动，免得点一下就把工作区跳走。
   */
  function selectTreeNode(node: SchemaNode) {
    setActiveNode(node);

    if (!session)
      return;

    if (node.kind === "QUERY") {
      void showScriptList({ highlightName: node.path ? node.label : undefined });
      return;
    }

    if (node.kind === "CATALOG" || node.kind === "SCHEMA" || node.kind === "TABLE")
      void showTableList(node, { quiet: true });
  }

  /** 当前连接共用的「对象」列（不存在时返回 null） */
  function findObjectTab(): ObjectTab | null {
    return tabs.find((tab): tab is ObjectTab => tab.kind === "objects") ?? null;
  }

  /**
   * 让「对象」列显示某个节点下的数据表列表（Navicat 风格的对象页）。
   *
   * - 选中表 → 显示它所在的容器，并把该表高亮；
   * - 选中库 / 模式 / 表容器 → 显示它们下面的表容器；
   * - 页面已存在就地换内容（不会再开第二个「对象」标签），并且固定在最左侧；
   * - `force` 为 false（树选中联动）时优先用已有内容，不重新读库。
   */
  async function showTableList(source: SchemaNode, options: { force?: boolean; quiet?: boolean } = {}) {
    if (!session) {
      if (!options.quiet)
        setError("请先在左侧选择一个连接");

      return;
    }

    /* 选中的是表 → 展示它所在的容器，并把这个表标为当前项 */
    let target = source;
    const highlight = source.kind === "TABLE" && !source.hasChildren ? source.label : null;

    if (highlight) {
      const parent = parentTreeNode(source.id);

      if (parent)
        target = parent;
    }

    let container = target.kind === "TABLE" && target.hasChildren ? target : null;

    if (!container) {
      const children = await loadChildren(session.sessionId, target);
      container = children.find(child => child.kind === "TABLE" && child.hasChildren) ?? null;
    }

    if (!container) {
      /* 树选中联动时不要弹窗打扰，只在状态栏说一声 */
      if (options.quiet)
        setStatus(`${target.label} 下没有数据表`);
      else
        setError(`${target.label} 下没有数据表`);

      return;
    }

    const existing = findObjectTab();
    const sameContainer = existing?.view === "tables" && existing.node
      && existing.node.catalog === container.catalog
      && existing.node.schema === container.schema;

    /* 已经在看同一批表：只切过去 / 改高亮，不重新读库 */
    if (existing && sameContainer && !options.force) {
      setActiveTabId(existing.id);
      setTableSelection(highlight ? [highlight] : []);
      return;
    }

    const tables = await loadTableNodes(container, options.force ?? false);

    /* 切换库 / 模式时也让列表"空一下再出现"，和刷新一个观感 */
    setListFlash(previous => previous + 1);

    if (existing) {
      /* 更新内容，并把它固定在标签栏最左侧（不允许被移动/挤走） */
      setTabs(previous => {
        const current = previous.find(tab => tab.id === existing.id);

        if (!current)
          return previous;

        return [
          {
            ...current,
            view: "tables",
            node: container,
            tables,
            loading: false,
            title: OBJECT_TAB_TITLE
          } as WorkTab,
          ...previous.filter(tab => tab.id !== existing.id)
        ];
      });
      setActiveTabId(existing.id);
      setTableFilter("");
      setTableSelection(highlight ? [highlight] : []);
      return;
    }

    const tab: ObjectTab = {
      id: `tab-${tabSequence++}`,
      kind: "objects",
      view: "tables",
      title: OBJECT_TAB_TITLE,
      running: false,
      messages: [],
      node: container,
      tables,
      scripts: [],
      loading: false
    };

    setTabs(previous => [tab, ...previous]);
    setActiveTabId(tab.id);
    setTableFilter("");
    setTableSelection(highlight ? [highlight] : []);
  }

  /** 显式打开表列表（工具栏 / 右键 / 菜单）：重新读一遍表 */
  async function openTableList(source: SchemaNode) {
    await showTableList(source, { force: true });
  }

  async function loadTableNodes(container: SchemaNode, force = true): Promise<SchemaNode[]> {
    if (!session)
      return [];

    const children = await loadChildren(session.sessionId, container, force);

    return children.filter(node => node.kind === "TABLE" && !node.hasChildren);
  }

  async function refreshTableList(tabId: string, container: SchemaNode) {
    setPending("tableList");
    updateTab(tabId, { loading: true, view: "tables" });

    try {
      const tables = await loadTableNodes(container);

      /* 顺带把标签页绑定的容器节点换成刚读到的这份，后续刷新继续对齐 */
      updateTab(tabId, { view: "tables", tables, node: container, loading: false, title: OBJECT_TAB_TITLE });
      setStatus(`已刷新 ${tables.length} 张表`);
      setListFlash(previous => previous + 1);
    } catch (e) {
      updateTab(tabId, { loading: false });
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  }

  /**
   * 刷新对象：树 / 菜单 / 对象页右键的刷新入口全部走这里。
   *
   * 只要「对象」页开着，就交给 `refreshTableList` —— 和顶部刷新按钮是同一个调用、
   * 同一条路径（pending 忙碌态 → 重读表 → 列表闪烁），右键与按钮表现必然一致。
   * 没开对象页时只重读树节点，不给不存在的列表闪。
   */
  async function refreshObjectList(node: SchemaNode) {
    const active = sessionRef.current;

    if (!active)
      return;

    try {
      const candidates = await containerCandidates(active.sessionId, node);
      /* 对象列只要是打开的（哪怕是脚本视图）都接受刷新，refreshTableList 会把它切回表列表 */
      const page = tabs.find((tab): tab is ObjectTab => tab.kind === "objects");

      if (page) {
        /*
         * 能拿到同一批对象的「新」容器节点就用它（节点 id 每次加载都会变），
         * 拿不到就直接用页面自己绑定的容器 —— 无论如何都走页面刷新这条路。
         */
        const fresh = candidates.find(item =>
          item.catalog === page.node?.catalog && item.schema === page.node?.schema);
        const container = fresh ?? page.node;

        if (!container) {
          setError("对象列表还没绑定数据库，请重新打开一次");
          return;
        }

        await refreshTableList(page.id, container);
        return;
      }

      if (candidates.length === 0) {
        setStatus(`已刷新 ${node.label}`);
        flash(`已刷新 ${node.label}`);
        return;
      }

      await loadTableNodes(candidates[0]);
      setStatus(`已刷新 ${node.label}`);
      flash(`已刷新 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /**
   * 一个节点可能对应的「表容器」新节点：
   * 表容器 → 自己；表 → 父容器；库 / 模式 → 底下的容器（库还要再往下走一层模式）。
   */
  async function containerCandidates(sessionId: string, node: SchemaNode): Promise<SchemaNode[]> {
    if (node.kind === "TABLE" && node.hasChildren)
      return [node];

    if (node.kind === "TABLE") {
      const parent = parentTreeNode(node.id);

      return parent && parent.kind === "TABLE" && parent.hasChildren ? [parent] : [];
    }

    if (node.kind !== "CATALOG" && node.kind !== "SCHEMA")
      return [];

    const children = await loadChildren(sessionId, node, true);
    const direct = children.find(child => child.kind === "TABLE" && child.hasChildren);
    const found = direct ? [direct] : [];

    for (const schema of children.filter(child => child.kind === "SCHEMA")) {
      const grand = await loadChildren(sessionId, schema, true);
      const container = grand.find(child => child.kind === "TABLE" && child.hasChildren);

      if (container)
        found.push(container);
    }

    return found;
  }

  function openTableDesign(node: SchemaNode) {
    if (!node.table)
      return;

    const existing = tabs.find(tab => tab.kind === "design" && tab.node.table?.name === node.table?.name);

    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const tab: DesignTab = {
      id: `tab-${tabSequence++}`,
      kind: "design",
      title: `设计: ${node.label}`,
      running: false,
      messages: [],
      node,
      columns: [],
      indexes: [],
      ddl: "",
      loading: true
    };

    setTabs(previous => [...previous, tab]);
    setActiveTabId(tab.id);
    void loadDesign(tab.id, node);
  }

  /* 双击对象：连接 / 展开 / 打开数据 */
  function activateNode(node: SchemaNode) {
    if (node.kind === "TABLE" && !node.hasChildren && node.table) {
      openTableData(node);
      return;
    }

    /* 查询脚本文件：双击打开到查询控制台 */
    if (node.kind === "QUERY" && node.path) {
      void openScript(node);
      return;
    }

    /* 「查询脚本」容器：双击直接进脚本对象页，比一层层展开目录更顺手 */
    if (node.kind === "QUERY") {
      void toggleNode(node);
      void openScriptList();
      return;
    }

    /* 打开数据库 / 模式：展开对象树的同时把「对象」页显示出来 */
    if (node.kind === "CATALOG" || node.kind === "SCHEMA") {
      void toggleNode(node);
      void openTableList(node);
      return;
    }

    if (node.kind === "CONNECTION" || node.hasChildren)
      void toggleNode(node);
  }

  /* ------------------------------ 查询脚本 ------------------------------ */

  /** 打开脚本文件（对象树里的脚本节点与「脚本」页共用一条路径） */
  async function openScriptFile(file: { name: string; catalog: string }) {
    if (!session) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const existing = tabs.find(tab =>
      tab.kind === "query" && tab.script?.name === file.name && tab.script?.catalog === file.catalog);

    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    try {
      const payload = await invoke<{ content: string }>("queryFiles.read", {
        connection: session.name,
        catalog: file.catalog,
        name: file.name
      });

      const tab = newQueryTab();
      tab.title = file.name;
      tab.sql = payload.content;
      tab.savedSql = payload.content;
      tab.script = { connection: session.name, catalog: file.catalog, name: file.name };
      tab.path = { connection: session.name, catalog: file.catalog };

      setTabs(previous => [...previous, tab]);
      setActiveTabId(tab.id);
      setStatus(`已打开脚本 ${file.name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function openScript(node: SchemaNode) {
    await openScriptFile({ name: node.label, catalog: node.catalog ?? "default" });
  }

  /** 当前上下文所属的数据库目录（脚本按「连接/数据库」分目录存放） */
  function scriptCatalog(): string {
    if (activeNode?.kind === "CATALOG")
      return activeNode.label;

    return activeNode?.catalog ?? catalogOptions[0]?.label ?? "default";
  }

  /**
   * 新建表：按当前连接的类型生成一份建表草稿放进查询控制台，
   * 由用户确认 / 补全后再执行 —— 各数据库的建表语法差异很大，
   * 与其替用户猜，不如给一份能直接改的模板。
   */
  async function createTableDraft(catalogHint?: string) {
    if (!session) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const name = await askText("新建表（生成建表草稿）", "new_table");

    if (!name)
      return;

    const type = (session.product.type ?? connections.find(item => item.name === session.name)?.type ?? "mysql").toLowerCase();
    const catalog = catalogHint ?? scriptCatalog();
    const tab = await openQueryTab();

    if (!tab)
      return;

    updateTab(tab.id, {
      title: `新建表 ${name}`,
      sql: createTableTemplate(name, type),
      path: { ...tab.path, catalog }
    });
    setStatus(`已生成建表草稿，确认无误后按 ${KEY.run} 执行`);
  }

  /** 新建脚本：问到名字后写进当前上下文所在的数据库目录，并直接打开 */
  async function createScript(catalogHint?: string) {
    const active = sessionRef.current;

    if (!active) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const catalog = catalogHint ?? scriptCatalog();
    const name = await askText(`新建脚本（保存到 ${catalog}）`, "新建查询.sql");

    if (!name)
      return;

    const fileName = name.toLowerCase().endsWith(".sql") ? name : `${name}.sql`;
    const content = `-- ${fileName.replace(/\.sql$/i, "")}\n`;

    try {
      await invoke("queryFiles.save", { connection: active.name, catalog, name: fileName, content });

      await refreshScriptTree();

      /* 对象列正显示脚本就同步刷新，不然新脚本看不见；显示表列表时不要顶掉它 */
      const listTab = findObjectTab();

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      await openScriptFile({ name: fileName, catalog });
      setStatus(`已创建脚本 ${fileName}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** 重命名脚本（新名字不带 .sql 时自动补上） */
  async function renameScriptFile(file: { name: string; catalog: string }) {
    const active = sessionRef.current;

    if (!active)
      return;

    const input = await askText(`重命名脚本（${file.catalog}）`, file.name);

    if (!input)
      return;

    const name = input.toLowerCase().endsWith(".sql") ? input : `${input}.sql`;

    if (name === file.name)
      return;

    try {
      await invoke("queryFiles.rename", {
        connection: active.name,
        catalog: file.catalog,
        oldName: file.name,
        newName: name
      });

      /* 已打开的标签同步改名，避免保存时写回旧文件 */
      setTabs(previous => previous.map(tab =>
        tab.kind === "query" && tab.script?.name === file.name && tab.script?.catalog === file.catalog
          ? { ...tab, title: name, script: { ...tab.script, name } }
          : tab));

      await refreshScriptTree();

      const listTab = findObjectTab();

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      setStatus(`已重命名为 ${name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function renameScript(node: SchemaNode) {
    await renameScriptFile({ name: node.label, catalog: node.catalog ?? "default" });
  }

  /** 删除脚本：支持一次删多个（脚本页多选后删除） */
  async function deleteScriptFiles(files: { name: string; catalog: string }[]) {
    const active = sessionRef.current;

    if (!active || files.length === 0)
      return;

    const title = files.length === 1 ? files[0].name : `选中的 ${files.length} 个脚本`;
    const confirmed = await askConfirm(`确认删除 ${title}？删除后无法恢复。`, "删除脚本", true);

    if (!confirmed)
      return;

    try {
      for (const file of files)
        await invoke("queryFiles.delete", { connection: active.name, catalog: file.catalog, name: file.name });

      /* 关掉这些脚本对应的查询页 */
      const opened = tabs.filter(tab =>
        tab.kind === "query" && tab.script && files.some(file => file.name === tab.script?.name && file.catalog === tab.script?.catalog));

      if (opened.length > 0)
        setTabs(previous => previous.filter(tab => !opened.some(item => item.id === tab.id)));

      await refreshScriptTree();

      const listTab = findObjectTab();

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      setScriptSelection([]);
      setStatus(`已删除 ${files.length} 个脚本`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function deleteScript(node: SchemaNode) {
    await deleteScriptFiles([{ name: node.label, catalog: node.catalog ?? "default" }]);
  }

  /* 拉取当前连接下所有数据库目录里的脚本（脚本对象页数据源） */
  async function loadScriptFiles(): Promise<ScriptFile[]> {
    const active = sessionRef.current;

    if (!active)
      return [];

    const payload = await invoke<{ files: ScriptFile[] }>("queryFiles.list", { connection: active.name });
    return payload.files ?? [];
  }

  /**
   * 「脚本」对象页：和「对象」页一样是整连接共用一个标签页，
   * 列出所有数据库目录下的 .sql，双击打开、右键重命名 / 删除 / 在文件夹中显示。
   */
  /**
   * 让「对象」列显示脚本列表（当前连接下所有库的 .sql）。
   * 与表列表共用同一个「对象」标签，只是切换内容；选中脚本节点时会定位到那一行。
   */
  async function showScriptList(options: { force?: boolean; highlightName?: string } = {}) {
    if (!session) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const existing = findObjectTab();

    /* 已经在看脚本列表：只切过去 / 定位，不重新扫目录 */
    if (existing?.view === "scripts" && !options.force) {
      setActiveTabId(existing.id);
      highlightScript(existing, options.highlightName);
      return;
    }

    const scripts = await loadScriptFiles().catch(error => {
      setError(messageOf(error));
      return [] as ScriptFile[];
    });

    setScriptFlash(previous => previous + 1);

    if (existing) {
      setTabs(previous => previous.map(tab => tab.id === existing.id
        ? { ...tab, view: "scripts", scripts, loading: false, title: OBJECT_TAB_TITLE } as WorkTab
        : tab));
      setActiveTabId(existing.id);
      setScriptFilter("");
      highlightScript({ scripts }, options.highlightName);
      return;
    }

    const tab: ObjectTab = {
      id: `tab-${tabSequence++}`,
      kind: "objects",
      view: "scripts",
      title: OBJECT_TAB_TITLE,
      running: false,
      messages: [],
      node: null,
      tables: [],
      scripts,
      loading: false
    };

    /* 「对象」列固定在标签栏最左侧 */
    setTabs(previous => [tab, ...previous]);
    setActiveTabId(tab.id);
    setScriptFilter("");
    highlightScript({ scripts }, options.highlightName);
  }

  /** 按脚本文件名定位选中项（树节点只有名字，选中状态用的是绝对路径） */
  function highlightScript(source: { scripts: ScriptFile[] }, name?: string) {
    const hit = name ? source.scripts.find(script => script.name === name) : undefined;

    setScriptSelection(hit ? [hit.path] : []);
  }

  /** 显式打开脚本列表（工具栏 / 右键 / 菜单）：重新扫一遍脚本目录 */
  async function openScriptList() {
    await showScriptList({ force: true });
  }

  async function refreshScriptList(tabId: string) {
    updateTab(tabId, { loading: true, view: "scripts" });

    try {
      const scripts = await loadScriptFiles();

      updateTab(tabId, { view: "scripts", scripts, loading: false, title: OBJECT_TAB_TITLE });
      setScriptFlash(previous => previous + 1);
    } catch (e) {
      updateTab(tabId, { loading: false });
      setError(messageOf(e));
    }
  }

  /* 刷新对象树里所有「查询脚本」容器，让树上的脚本列表跟上文件变化 */
  async function refreshScriptTree() {
    const active = sessionRef.current;

    if (!active)
      return;

    const containers = Object.values(treeChildren)
      .flat()
      .filter(node => node.kind === "QUERY" && !node.path);

    await Promise.all(containers.map(node =>
      loadChildren(active.sessionId, node, true).catch(() => [])));
  }

  async function saveActiveScript(saveAs = false) {
    if (!activeTab || activeTab.kind !== "query")
      return;

    if (!session) {
      setError("请先连接数据库，再保存脚本");
      return;
    }

    const script = activeTab.script;
    const content = activeTab.sql;
    const catalog = activeTab.path.catalog ?? scriptCatalog();
    /* 已有脚本就存回它原本的数据库目录，避免另存为跑到别的库里去 */
    const target = script?.catalog ?? catalog;

    try {
      if (!script || saveAs) {
        const name = await askText(`保存查询脚本（${target}）`, script?.name ?? `${activeTab.title}.sql`);

        if (!name)
          return;

        const fileName = name.toLowerCase().endsWith(".sql") ? name : `${name}.sql`;

        await invoke("queryFiles.save", {
          connection: session.name,
          catalog: target,
          name: fileName,
          content
        });

        updateTab(activeTab.id, {
          title: fileName,
          savedSql: content,
          script: { connection: session.name, catalog: target, name: fileName }
        });

        await refreshScriptTree();

        const listTab = findObjectTab();

        if (listTab?.view === "scripts")
          void refreshScriptList(listTab.id);

        setStatus(`已保存脚本 ${fileName}`);
        return;
      }

      await invoke("queryFiles.save", {
        connection: script.connection,
        catalog: script.catalog,
        name: script.name,
        content
      });

      updateTab(activeTab.id, { savedSql: content });

      const listTab = findObjectTab();

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      setStatus(`已保存脚本 ${script.name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** 查询页绑定了脚本文件、且内容与上次保存的不一致 → 有未保存修改 */
  function isScriptDirty(tab: WorkTab): boolean {
    return tab.kind === "query" && Boolean(tab.script) && tab.savedSql != null && tab.savedSql !== tab.sql;
  }

  /** 这个标签关掉会丢东西吗：脚本没存盘 or 结果集里有未提交的修改 */
  function hasUnsaved(tab: WorkTab): boolean {
    return isScriptDirty(tab) || (tab.pending ?? 0) > 0;
  }

  function describeUnsaved(tab: WorkTab): string {
    if (isScriptDirty(tab))
      return `· ${tab.title}（脚本未保存）`;

    return `· ${tab.title}（${tab.pending ?? 0} 条未提交修改）`;
  }

  async function exportResult(format: "csv" | "excel") {
    if (!currentResult?.jobId)
      return;

    const extension = format === "csv" ? "csv" : "xlsx";
    const target = await chooseSavePath({
      title: "导出查询结果",
      defaultPath: `result-${Date.now()}.${extension}`,
      filters: format === "csv"
        ? [{ name: "CSV 文件", extensions: ["csv"] }]
        : [{ name: "Excel 文件", extensions: ["xlsx"] }]
    });

    if (!target)
      return;

    try {
      await invoke("result.export", { jobId: currentResult.jobId, format, path: target });
      setStatus(`已导出到 ${target}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function updateQueryPath(patch: Partial<QueryTab["path"]>) {
    setTabs(previous => previous.map(tab =>
      tab.id === activeTabId && tab.kind === "query" ? { ...tab, path: { ...tab.path, ...patch } } : tab));
  }

  /* ------------------------------ 对象操作 ------------------------------ */

  /** 执行表设计页里编辑过的 DDL（先确认，再重新读取结构与表列表） */
  async function applyTableDdl(tabId: string, node: SchemaNode, ddl: string) {
    if (!session)
      return;

    const confirmed = await askConfirm(
      `确定执行下面这段 DDL？它会直接改动数据库里的对象，无法撤销。\n\n${ddl.length > 400 ? `${ddl.slice(0, 400)}…` : ddl}`,
      "执行 DDL",
      true
    );

    if (!confirmed)
      return;

    try {
      await withBusy(() => invoke("query.execute", {
        sessionId: session.sessionId,
        sql: ddl,
        jobId: Date.now(),
        catalog: node.catalog,
        schema: node.schema
      }));

      await loadDesign(tabId, node);
      await refreshObjectList(node);
      setStatus("DDL 已执行");
      flash("DDL 已执行");
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard?.writeText(text);
      setStatus(`已复制：${text.length > 40 ? text.slice(0, 40) + "…" : text}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function copyDdl(node: SchemaNode) {
    if (!session)
      return;

    try {
      const payload = await invoke<{ ddl: string }>("table.ddl", tableParams(session.sessionId, node));
      await copyText(payload.ddl);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function disconnect() {
    if (!session)
      return;

    /* 有没保存的内容就先确认：断开后脚本页与结果集都会一起收走 */
    const unsaved = tabs.filter(hasUnsaved);

    if (unsaved.length > 0) {
      const confirmed = await askConfirm(
        `以下标签还有没保存的内容：\n${unsaved.map(describeUnsaved).join("\n")}\n\n断开连接后这些改动会丢失，确定断开吗？`,
        "未保存的修改",
        true
      );

      if (!confirmed)
        return;
    }

    await invoke("connection.close", { sessionId: session.sessionId }).catch(() => undefined);

    /*
     * 真正的断开：连接相关的东西全部清掉 ——
     * 数据页 / 表设计页 / 「对象」页随连接失效，直接关闭；
     * 查询控制台保留 SQL 文本（避免丢未保存的内容），但结果集、消息、执行计划与执行上下文一起清空。
     */
    const remaining = tabs
      .filter(tab => tab.kind === "query")
      .map(tab => ({ ...tab, result: null, plan: null, messages: [], running: false, path: {} } as WorkTab));

    setTabs(remaining);
    setActiveTabId(previous => (remaining.some(tab => tab.id === previous) ? previous : remaining[0]?.id ?? ""));
    setResultPane("grid");

    setSession(null);
    setRoots([]);
    setChildrenMap({});
    setCatalogOptions([]);
    setSchemaOptions([]);
    /* 只收起连接下面的库/表，连接列表本身要留在原地（否则关一个连接整个列表都不见了） */
    setExpanded(new Set(["conn-root"]));
    setActiveNode(null);
    setTableNodes([]);
    setTableFilter("");
    setTreeFilter("");
    setScriptFilter("");
    setScriptSelection([]);
    setGridHits(null);
    setGridSearch("");
    setGridKeyword("");
    setTableSelection([]);
    setGridSelection(null);
    setInfoColumns([]);
    setInfoIndexes([]);
    setLogs([]);
    setLastCost(null);
    setError(null);
    setStatus("已断开连接");
  }

  /* 重新拉取某个节点的下一级对象 */
  async function refreshNode(node: SchemaNode) {
    const active = sessionRef.current;

    if (!active)
      return;

    try {
      await withBusy(() => loadChildren(active.sessionId, node, true));
      setStatus(`已刷新 ${node.label}`);
      flash(`已刷新 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /* 执行一条语句（用于清空表 / 删除表这类对象操作） */
  async function executeStatement(sql: string) {
    if (!session)
      return;

    await invoke<QueryResultPayload>("query.execute", {
      sessionId: session.sessionId,
      sql,
      jobId: Date.now(),
      catalog: activeNode?.catalog,
      schema: activeNode?.schema
    });
  }

  async function clearTable(node: SchemaNode) {
    const confirmed = await askConfirm(`确定清空表 ${node.label} 的全部数据？此操作不可恢复！`, "清空表", true);

    if (!confirmed)
      return;

    const sql = session?.product.type === "sqlite"
      ? `DELETE FROM ${node.label}`
      : `TRUNCATE TABLE ${node.label}`;

    try {
      await executeStatement(sql);
      await refreshObjectList(node);
      setStatus(`已清空 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function dropTable(node: SchemaNode) {
    const confirmed = await askConfirm(`确定删除表 ${node.label}？此操作不可恢复！`, "删除表", true);

    if (!confirmed)
      return;

    try {
      await executeStatement(`DROP TABLE ${node.label}`);
      await refreshObjectList(node);
      setStatus(`已删除 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** 「对象」页多选后批量删除表（一次确认，逐个执行） */
  async function dropTables(nodes: SchemaNode[]) {
    if (nodes.length === 0)
      return;

    const confirmed = await askConfirm(`确定删除选中的 ${nodes.length} 张表？此操作不可恢复！`, "删除表", true);

    if (!confirmed)
      return;

    try {
      for (const node of nodes) {
        await executeStatement(`DROP TABLE ${node.label}`);
        await refreshObjectList(node);
      }

      setStatus(`已删除 ${nodes.length} 张表`);
      flash(`已删除 ${nodes.length} 张表`);
      setTableSelection([]);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function deleteConnection(name: string) {
    const confirmed = await askConfirm(`确定要删除连接“${name}”吗？`, "删除连接", true);

    if (!confirmed)
      return;

    try {
      if (session?.name === name)
        await disconnect();

      await invoke("connections.delete", { name });
      await refreshConnections();
      setStatus(`已删除连接 ${name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /* 右键菜单：与 JavaFX 版本保持一致 */
  function buildContextMenu(node: SchemaNode): MenuEntry[] {
    const container = node.kind === "TABLE" && node.hasChildren;
    const isTable = node.kind === "TABLE" && !node.hasChildren && Boolean(node.table);
    const open = expanded.has(node.id);

    if (node.kind === "ROOT") {
      return [
        { label: "新建查询", action: createQueryTab },
        { label: "刷新连接", action: () => void refreshConnections() }
      ];
    }

    if (node.kind === "CONNECTION") {
      return [
        {
          label: node.connected ? "关闭连接" : "打开连接",
          /* 关闭连接 = 真正断开：关掉该连接下的数据页 / 设计页 / 对象页 */
          action: () => void (node.connected ? disconnect() : toggleNode(node))
        },
        { label: "新建查询", action: createQueryTab },
        { separator: true },
        { label: "刷新", action: () => void refreshNode(node) },
        { separator: true },
        { label: "复制连接名", action: () => void copyText(node.label) },
        { separator: true },
        {
          label: "编辑连接",
          action: () => {
            const connection = connections.find(item => item.name === node.label);

            if (connection)
              setConnectionDialog({ mode: "edit", connection });
          }
        },
        {
          label: "复制连接",
          action: () => {
            const connection = connections.find(item => item.name === node.label);

            if (connection)
              setConnectionDialog({ mode: "copy", connection });
          }
        },
        { label: "删除连接", danger: true, action: () => void deleteConnection(node.label) }
      ];
    }

    if (node.kind === "CATALOG") {
      return [
        { label: open ? "关闭数据库" : "打开数据库", action: () => void toggleNode(node) },
        { label: "表列表", action: () => void openTableList(node) },
        { label: "新建表…", action: () => void createTableDraft(node.label) },
        { label: "新建查询", action: createQueryTab },
        { separator: true },
        { label: "刷新", action: () => void refreshObjectList(node) },
        { label: "复制名称", action: () => void copyText(node.label) }
      ];
    }

    if (node.kind === "SCHEMA") {
      return [
        { label: open ? "收起模式" : "展开模式", action: () => void toggleNode(node) },
        { label: "表列表", action: () => void openTableList(node) },
        { label: "新建表…", action: () => void createTableDraft(node.label) },
        { label: "新建查询", action: createQueryTab },
        { separator: true },
        { label: "刷新列表", action: () => void refreshObjectList(node) },
        { label: "复制名称", action: () => void copyText(node.label) }
      ];
    }

    if (container) {
      return [
        { label: open ? "收起列表" : "展开列表", action: () => void toggleNode(node) },
        { label: "表列表", action: () => void openTableList(node) },
        { label: "新建表…", action: () => void createTableDraft(node.catalog) },
        { label: "刷新列表", action: () => void refreshObjectList(node) },
        { label: "新建查询", action: createQueryTab }
      ];
    }

    if (node.kind === "QUERY") {
      /* 查询脚本文件（容器没有本地路径，脚本文件有） */
      if (node.path) {
        return [
          { label: "打开查询", action: () => void openScript(node) },
          { separator: true },
          { label: "新建查询", action: createQueryTab },
          { label: "重命名脚本", action: () => void renameScript(node) },
          { separator: true },
          { label: "复制脚本名", action: () => void copyText(node.label) },
          { label: "复制路径", action: () => node.path && void copyText(node.path) },
          { label: "在文件夹中显示", action: () => node.path && void revealPath(node.path) },
          { separator: true },
          { label: "删除脚本", danger: true, action: () => void deleteScript(node) }
        ];
      }

      return [
        { label: "脚本列表", action: () => void openScriptList() },
        { label: "新建脚本", action: () => void createScript(node.catalog) },
        { label: "新建查询", action: createQueryTab },
        { separator: true },
        { label: open ? "收起列表" : "展开列表", action: () => void toggleNode(node) },
        { label: "刷新列表", action: () => void refreshNode(node) }
      ];
    }

    if (isTable) {
      return [
        { label: "打开表", action: () => openTableData(node) },
        { label: "设计表", action: () => openTableDesign(node) },
        { separator: true },
        { label: "复制表名", action: () => void copyText(node.label) },
        { label: "复制建表语句", action: () => void copyDdl(node) },
        { label: "复制查询语句", action: () => void copyText(`SELECT * FROM ${node.label};`) },
        { separator: true },
        { label: "清空表", danger: true, action: () => void clearTable(node) },
        { label: "删除表", danger: true, action: () => void dropTable(node) },
        { separator: true },
        { label: "刷新列表", action: () => void refreshObjectList(node) }
      ];
    }

    return [];
  }

  async function loadPage(tabId: string, node: SchemaNode, page: number, pageSize: number) {
    if (!session)
      return;

    setPending("loadPage");

    try {
      const payload = await invoke<QueryResultPayload>("table.page", {
        ...tableParams(session.sessionId, node),
        offset: page * pageSize,
        size: pageSize
      });

      updateTab(tabId, { result: payload, page, pageSize, running: false });
      setStatus(`读取 ${node.label} 第 ${page + 1} 页`);
    } catch (e) {
      setError(messageOf(e));
      updateTab(tabId, { running: false });
    } finally {
      setPending(null);
    }
  }

  async function loadDesign(tabId: string, node: SchemaNode) {
    if (!session)
      return;

    const params = tableParams(session.sessionId, node);

    try {
      const [columns, indexes, ddl] = await Promise.all([
        invoke<{ columns: TableColumn[] }>("table.columns", params),
        invoke<{ indexes: TableIndex[] }>("table.indexes", params),
        invoke<{ ddl: string }>("table.ddl", params)
      ]);

      updateTab(tabId, {
        columns: columns.columns,
        indexes: indexes.indexes,
        ddl: ddl.ddl,
        loading: false
      });
    } catch (e) {
      setError(messageOf(e));
      updateTab(tabId, { loading: false });
    }
  }

  /* ------------------------------ 执行 ------------------------------ */

  const runQuery = useCallback(async (tabId: string, sql: string) => {
    if (!session) {
      setError("请先在左侧选择一个连接");
      return;
    }

    if (!sql.trim())
      return;

    const jobId = Date.now();
    const tab = tabs.find(item => item.id === tabId);
    const context = tab?.kind === "query" ? tab.path : {};

    jobTabRef.current.set(jobId, tabId);
    runningJobRef.current.set(tabId, jobId);
    setError(null);
    setStatus("执行中…");
    setLastCost(null);
    updateTab(tabId, { running: true, messages: [] });
    /* 执行期间先停留日志页，等真正有结果集再切到结果页 */
    setResultPane("log");

    try {
      const payload = await invoke<QueryResultPayload>("query.execute", {
        sessionId: session.sessionId,
        sql,
        jobId,
        catalog: context.catalog,
        schema: context.schema
      });

      const rows = payload.rows?.length ?? 0;
      const summary = payload.hasResultSet ? `返回 ${rows} 行` : "执行成功";

      updateTab(tabId, {
        result: payload,
        running: false,
        messages: [...(tabs.find(tab => tab.id === tabId)?.messages ?? []), summary]
      });
      setStatus(summary);

      if (payload.hasResultSet)
        setResultPane("grid");
    } catch (e) {
      const message = messageOf(e);

      /* 语句执行失败：写进日志面板（不弹窗、不占工作区顶部） */
      const line = formatErrorLog(message);

      setLogs(previous => appendLog(previous, errorRecord(message, jobId)));
      setResultPane("log");
      setStatus("执行失败");
      updateTab(tabId, { running: false, messages: [line] });
    } finally {
      jobTabRef.current.delete(jobId);
      runningJobRef.current.delete(tabId);
    }
  }, [session, tabs]);

  async function runSelectionOrAll() {
    const editor = editorRef.current;

    if (!editor || !activeTab || activeTab.kind !== "query")
      return;

    const selection = editor.getSelection();
    const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) ?? "" : "";

    await runQuery(activeTab.id, selected.trim() ? selected : activeTab.sql);
  }

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

  /*
   * 窗口级快捷键：Ctrl+R 执行、Ctrl+A 全选、Ctrl+Shift+F 格式化、
   * Ctrl+S / Ctrl+Shift+S 保存脚本。
   * 编辑器有焦点时，除 Ctrl+R 外都交给 Monaco 自己的命令处理，避免同一个动作触发两次
   * （Monaco 没有绑 Ctrl+R，所以执行必须在这里兜底）。
   */
  const runShortcutRef = useRef<() => void>(() => undefined);
  runShortcutRef.current = () => void runSelectionOrAll();
  const formatShortcutRef = useRef<() => void>(() => undefined);
  formatShortcutRef.current = () => void formatActiveQuery();
  const saveShortcutRef = useRef<(saveAs?: boolean) => void>(() => undefined);
  saveShortcutRef.current = (saveAs?: boolean) => void saveActiveScript(saveAs);
  const selectAllRef = useRef<() => void>(() => undefined);
  selectAllRef.current = () => void selectAllInPage();

  /* 结果集搜索防抖：连续输入时只在停顿后过滤一次（同 FX 版 100ms） */
  useEffect(() => {
    const timer = window.setTimeout(() => setGridKeyword(gridSearch), 120);
    return () => window.clearTimeout(timer);
  }, [gridSearch]);

  /*
   * 搜索中依然可编辑：行下标用的始终是原始行号，删除 / 置空只作用于「可见行」
   * （见 selectionRows），所以过滤状态下改数据是安全的。
   */
  const searchingGrid = gridKeyword.trim().length > 0;

  /* 换标签页 / 换结果集时清掉上一个结果集的搜索 */
  useEffect(() => {
    setGridSearch("");
    setGridKeyword("");
  }, [activeTabId]);

  /* macOS 菜单栏把 ⌘A 转发过来（原生菜单会先吃掉这个组合键） */
  useEffect(() => onShortcut(action => {
    if (action === "select-all")
      selectAllRef.current();
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey)
        return;

      const key = event.key.toLowerCase();
      const shift = event.shiftKey;
      const target = event.target as HTMLElement | null;

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

  async function stopQuery() {
    if (!session || !activeTab || !activeTab.running)
      return;

    const jobId = runningJobRef.current.get(activeTab.id);

    if (jobId == null)
      return;

    await invoke("query.cancel", { sessionId: session.sessionId, jobId }).catch(() => undefined);
    setStatus("已请求取消");
  }

  async function formatActiveQuery() {
    if (!activeTab || activeTab.kind !== "query")
      return;

    try {
      const payload = await invoke<{ sql: string }>("sql.format", { sql: activeTab.sql });
      const editor = editorRef.current;
      const model = editor?.getModel();

      /*
       * 用一次可撤销的编辑替换全文，而不是 setValue（setValue 会清空撤销栈，
       * 格式化后就按不回原来的写法了）。内容变更事件会顺带同步 tab.sql。
       */
      if (editor && model) {
        editor.pushUndoStop();
        editor.executeEdits("valkyrie.format", [{
          range: model.getFullModelRange(),
          text: payload.sql,
          forceMoveMarkers: true
        }]);
        editor.pushUndoStop();
        return;
      }

      updateTab(activeTab.id, { sql: payload.sql });
    } catch (e) {
      /* 格式化不是语句执行，走系统提示 */
      setError(messageOf(e));
    }
  }

  async function explainActiveQuery() {
    if (!session || !activeTab || activeTab.kind !== "query")
      return;

    setResultPane("plan");
    setStatus("解析执行计划…");

    const jobId = Date.now();

    try {
      const payload = await invoke<QueryResultPayload>("query.execute", {
        sessionId: session.sessionId,
        sql: `EXPLAIN ${activeTab.sql.replace(/;\s*$/, "")}`,
        jobId
      });

      updateTab(activeTab.id, { plan: payload });
      setStatus("执行计划已生成");
    } catch (e) {
      /* 执行计划解析失败：同样写进日志面板 */
      const message = messageOf(e);

      setLogs(previous => appendLog(previous, errorRecord(message, jobId)));
      setResultPane("log");
      setStatus("执行计划解析失败");
    }
  }

  /* ------------------------------ 视图派生数据 ------------------------------ */

  const columns = useMemo(() => {
    if (!activeTab)
      return [];

    if (activeTab.kind === "design")
      return activeTab.columns;

    /* 「对象」列自己渲染列表，没有结果集 */
    if (activeTab.kind === "objects")
      return [];

    return activeTab.result?.columns ?? [];
  }, [activeTab]);

  const rows = activeTab && "result" in activeTab ? activeTab.result?.rows ?? [] : [];
  const productLabel = session ? `${session.product.productName ?? ""} ${session.product.version ?? ""}`.trim() : "-";
  const currentDatabase = activeNode?.catalog ?? "-";

  /* ------------------------------ 结果集编辑 ------------------------------ */

  const currentResult = activeTab && "result" in activeTab ? activeTab.result : null;

  /* 选区 → 行/列序号列表（右键菜单、按钮对整块选区生效） */
  /* 「对象」页当前选中的表（工具栏的打开/设计按钮作用于全部选中项） */
  const objectSelections = activeTab?.kind === "objects" && activeTab.view === "tables"
    ? activeTab.tables.filter(node => tableSelection.includes(node.label))
    : [];

  /* 对象列（脚本视图）里选中的脚本 */
  const scriptSelections = activeTab?.kind === "objects" && activeTab.view === "scripts"
    ? activeTab.scripts.filter(script => scriptSelection.includes(script.path))
    : [];

  /* 对象列是整页列表：结果集那一套面板（消息 / 执行计划 / 日志）在这里不出现 */
  const pageTab = activeTab?.kind === "objects";

  /* 对象列（脚本视图）右键菜单：多选时换成批量版本 */
  function buildScriptMenuEntries(script: ScriptFile): MenuEntry[] {
    const batch = scriptSelection.length > 1 && scriptSelection.includes(script.path);

    if (batch) {
      return [
        { label: `打开选中的 ${scriptSelections.length} 个脚本`, action: () => scriptSelections.forEach(item => void openScriptFile(item)) },
        { separator: true },
        { label: `删除选中的 ${scriptSelections.length} 个脚本`, danger: true, action: () => void deleteScriptFiles(scriptSelections) }
      ];
    }

    return [
      { label: "打开", action: () => void openScriptFile(script) },
      { separator: true },
      { label: "新建脚本", action: () => void createScript(script.catalog) },
      { label: "重命名", action: () => void renameScriptFile(script) },
      { separator: true },
      { label: "复制脚本名", action: () => void copyText(script.name) },
      { label: "复制路径", action: () => void copyText(script.path) },
      { label: "在文件夹中显示", action: () => void revealPath(script.path) },
      { separator: true },
      { label: "删除脚本", danger: true, action: () => void deleteScriptFiles([script]) }
    ];
  }

  /* 「对象」页右键菜单：多选时换成批量版本 */
  function buildObjectMenu(node: SchemaNode): MenuEntry[] {
    const batch = tableSelection.length > 1 && tableSelection.includes(node.label);

    if (!batch)
      return buildContextMenu(node);

    return [
      { label: `打开选中的 ${objectSelections.length} 张表`, action: () => objectSelections.forEach(item => openTableData(item)) },
      { label: `设计选中的 ${objectSelections.length} 张表`, action: () => objectSelections.forEach(item => openTableDesign(item)) },
      { separator: true },
      { label: "复制表名", action: () => void copyText(tableSelection.join("\n")) },
      { label: "刷新列表", action: () => void refreshObjectList(node) },
      { separator: true },
      { label: `删除选中的 ${objectSelections.length} 张表`, danger: true, action: () => void dropTables(objectSelections) }
    ];
  }

  /* 编辑器右键菜单：与 JavaFX 版顺序一致（按右键时的选区状态现算） */
  function buildEditorMenuEntries(hasSelection: boolean): MenuEntry[] {
    if (activeTab?.kind !== "query")
      return [];

    return [
    {
      label: "运行已选择",
      accelerator: ACCEL.run,
      icon: "play",
      disabled: !hasSelection || activeTab.running,
      action: () => void runSelectionOrAll()
    },
    { label: "美化已选择", icon: "code", action: () => void formatActiveQuery() },
    { separator: true },
    { label: "复制", accelerator: ACCEL.copy, action: () => editorRef.current?.trigger("menu", "editor.action.clipboardCopyAction", null) },
    { label: "剪切", accelerator: ACCEL.cut, action: () => editorRef.current?.trigger("menu", "editor.action.clipboardCutAction", null) },
    { label: "粘贴", accelerator: ACCEL.paste, action: () => editorRef.current?.trigger("menu", "editor.action.clipboardPasteAction", null) },
    { label: "全选", accelerator: ACCEL.selectAll, action: () => editorRef.current?.trigger("menu", "editor.action.selectAll", null) },
    { separator: true },
    { label: "注释/取消注释", action: () => editorRef.current?.trigger("menu", "editor.action.commentLine", null) },
    { label: "转大写", action: () => editorRef.current?.trigger("menu", "editor.action.transformToUppercase", null) },
    { label: "转小写", action: () => editorRef.current?.trigger("menu", "editor.action.transformToLowercase", null) }
    ];
  }

  /*
   * 选区 → 行 / 列下标。优先用网格上报的「可见行」列表：搜索过滤时被隐藏的行
   * 不参与删除 / 置空，避免误伤看不见的数据。
   */
  const selectionRows = (selection: NonNullable<typeof gridSelection>) =>
    selection.rowList?.length
      ? selection.rowList
      : Array.from({ length: selection.r2 - selection.r1 + 1 }, (_, index) => selection.r1 + index);
  const selectionCols = (selection: NonNullable<typeof gridSelection>) =>
    selection.colList?.length
      ? selection.colList
      : Array.from({ length: selection.c2 - selection.c1 + 1 }, (_, index) => selection.c1 + index);

  /** 删除选中行：先确认（删除只是待提交的修改，可回滚） */
  async function deleteSelectedRows() {
    if (!gridSelection)
      return;

    const rows = selectionRows(gridSelection);
    const confirmed = await askConfirm(
      `确定删除选中的 ${rows.length} 行？删除后需点「提交修改」才会写入数据库，中途可以「回滚」。`,
      "删除行",
      true
    );

    if (confirmed)
      await runResultAction("result.delete", { rows }, "已删除选中行");
  }

  /* 结果表右键菜单（Radix ContextMenu 负责弹出/定位/关闭） */
  const gridMenuEntries: MenuEntry[] = [
    { label: "提交修改", disabled: !currentResult?.dirty, action: () => void runResultAction("result.commit", {}, "修改已提交") },
    { label: "新增行", disabled: !currentResult?.addable, action: () => void runResultAction("result.insert", {}, "已新增一行") },
    {
      label: "设置为 NULL",
      disabled: !currentResult?.editable || !gridSelection,
      action: () => gridSelection && void runResultAction("result.setNull", { rows: selectionRows(gridSelection), cols: selectionCols(gridSelection) }, "已设置为 NULL")
    },
    {
      label: "删除选中行",
      danger: true,
      disabled: !currentResult?.editable || !gridSelection,
      action: () => void deleteSelectedRows()
    },
    { separator: true },
    {
      label: "复制为…",
      icon: "copy",
      children: [
        { label: "INSERT 语句", action: () => void copyRows("insert") },
        { label: "UPDATE 语句", action: () => void copyRows("update") },
        { label: "JSON", action: () => void copyRows("json") }
      ]
    },
    { separator: true },
    { label: "导出 CSV", icon: "csv", action: () => void exportResult("csv") },
    { label: "导出 Excel", icon: "excel", action: () => void exportResult("excel") },
    { separator: true },
    { label: "刷新", action: () => void runResultAction("result.reload", {}, "已刷新") }
  ];

  /* 标签页右键菜单：按被点的那一项现算（系统原生菜单需要即时给出条目） */
  function buildTabMenuEntries(id: string): MenuEntry[] {
    const index = tabs.findIndex(tab => tab.id === id);

    if (index < 0)
      return [];

    return [
      { label: "关闭", disabled: tabs[index].kind === "objects", action: () => void closeTabs("current", id) },
      { label: "关闭左侧标签", disabled: index === 0, action: () => void closeTabs("left", id) },
      { label: "关闭右侧标签", disabled: index === tabs.length - 1, action: () => void closeTabs("right", id) },
      { separator: true },
      { label: "全部关闭", action: () => void closeTabs("all", id) }
    ];
  }

  async function runResultAction(method: string, params: Record<string, unknown> = {}, success?: string) {
    if (!activeTab || !("result" in activeTab) || !activeTab.result?.jobId)
      return;

    const { jobId, offset, size } = activeTab.result;
    const tabId = activeTab.id;
    const pendingBefore = activeTab.pending ?? 0;

    setPending(method);

    try {
      const payload = await withBusy(() => invoke<QueryResultPayload>(method, {
        jobId,
        ...params
      }));

      /* 累计/清零本次未提交的改动条数 */
      const rowParams = Array.isArray(params.rows) ? params.rows.length : 0;
      const delta = method === "result.update" || method === "result.insert"
        ? 1
        : method === "result.delete" || method === "result.setNull"
          ? rowParams
          : 0;
      const clearsPending = method === "result.commit" || method === "result.rollback" || method === "result.reload";

      updateTab(tabId, {
        result: { ...payload, offset, size },
        /* 记录哪些行有未提交修改，用于行高亮 */
        dirtyRows: resolveDirtyRows(method, params, activeTab.dirtyRows),
        pending: clearsPending ? 0 : pendingBefore + delta
      });

      /* 提交时把改动条数报出来 */
      const message = method === "result.commit"
        ? `已提交 ${pendingBefore} 条修改`
        : success;

      if (message) {
        setStatus(message);
        /* 刷新类动作不弹提示，改成表格闪一下 */
        if (method === "result.reload")
          setGridFlash(previous => previous + 1);
        else
          flash(message);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  }

  function rowToJson(columns: QueryColumn[], row: (string | null)[]): Record<string, string | null> {
    const json: Record<string, string | null> = {};

    columns.forEach((column, index) => {
      json[column.name || column.label] = row[index] ?? null;
    });

    return json;
  }

  async function copyRows(format: "json" | "insert" | "update") {
    if (!currentResult?.columns || !currentResult.rows)
      return;

    const columns = currentResult.columns;
    const allRows = currentResult.rows;
    const selectedRows = gridSelection
      ? selectionRows(gridSelection)
          .map(row => allRows[row])
          .filter((row): row is (string | null)[] => Array.isArray(row))
      : allRows;

    if (format === "json") {
      await copyText(JSON.stringify(selectedRows.map(row => rowToJson(columns, row ?? [])), null, 2));
      return;
    }

    /* 数据页用真实表名，查询结果集没有表名就用占位符 */
    const table = activeTab?.kind === "data" ? activeTab.node.label : "table";
    const name = (column: QueryColumn) => `\`${column.name || column.label}\``;

    if (format === "update") {
      /*
       * 复制为 UPDATE：有主键就用主键做条件，没有主键只能退化成"全列匹配"
       * （这种语句可能一次改到多行，SQL 里带注释提示一下）。
       */
      const keys = columns.filter(column => column.primary);
      const match = keys.length > 0 ? keys : columns;
      const assignments = (keys.length > 0 ? columns.filter(column => !keys.includes(column)) : columns);
      const hint = keys.length > 0 ? "" : "-- 该结果集没有主键信息，WHERE 使用全部列，请确认后再执行\n";

      const statements = selectedRows.map(row => {
        const set = assignments
          .map(column => `${name(column)} = ${sqlLiteral(row?.[columns.indexOf(column)] ?? null)}`)
          .join(", ");
        const where = match
          .map(column => {
            const value = row?.[columns.indexOf(column)] ?? null;
            return value === null ? `${name(column)} IS NULL` : `${name(column)} = ${sqlLiteral(value)}`;
          })
          .join(" AND ");

        return `UPDATE \`${table}\` SET ${set} WHERE ${where};`;
      }).join("\n");

      await copyText(hint + statements);
      return;
    }

    const statements = selectedRows
      .filter(Boolean)
      .map(row => {
        const names = columns.map(name).join(", ");
        const values = (row ?? []).map(value => sqlLiteral(value)).join(", ");

        return `INSERT INTO \`${table}\` (${names}) VALUES (${values});`;
      })
      .join("\n");

    await copyText(statements);
  }

  /* 对象树：我的连接 → 连接 → 数据库 → 数据表 → 表 */
  const treeRoot = useMemo<SchemaNode>(() => ({
    id: "conn-root",
    label: "我的连接",
    kind: "ROOT",
    hasChildren: true
  }), []);

  const treeChildren = useMemo(() => {
    const merged: Record<string, SchemaNode[]> = {
      ...childrenMap,
      "conn-root": connections.map(connection => ({
        id: `conn:${connection.name}`,
        label: connection.name,
        kind: "CONNECTION" as const,
        hasChildren: true,
        connected: session?.name === connection.name,
        dbType: connection.type
      }))
    };

    if (session)
      merged[`conn:${session.name}`] = roots;

    return merged;
  }, [childrenMap, connections, roots, session]);

  interface MenuItemDef {
    label?: string;
    action?: () => void;
    separator?: boolean;
    danger?: boolean;
    disabled?: boolean;
    /** 快捷键（Electron accelerator 写法），显示在菜单项右侧 */
    accelerator?: string;
  }

  const currentConnection = connections.find(item => item.name === session?.name) ?? null;

  /* 主题的解析结果（system 时看系统偏好）：供样式分支用，和主题 effect 同一套判断 */
  const themeResolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;

  const menus: { label: string; items: MenuItemDef[] }[] = [
    {
      label: "文件",
      items: [
        { label: "新建连接…", action: () => setConnectionDialog({ mode: "new" }) },
        { label: "编辑当前连接…", disabled: !currentConnection, action: () => setConnectionDialog({ mode: "edit", connection: currentConnection }) },
        { label: "复制当前连接…", disabled: !currentConnection, action: () => setConnectionDialog({ mode: "copy", connection: currentConnection }) },
        { label: "连接管理…", action: () => setManagerOpen(true) },
        { separator: true },
        { label: "删除当前连接", danger: true, disabled: !currentConnection, action: () => currentConnection && void deleteConnection(currentConnection.name) },
        { separator: true },
        { label: "新建脚本…", disabled: !session, action: () => void createScript() },
        { label: "脚本列表", disabled: !session, action: () => void openScriptList() },
        { separator: true },
        { label: "保存脚本", accelerator: ACCEL.save, disabled: activeTab?.kind !== "query", action: () => void saveActiveScript() },
        { label: "脚本另存为…", accelerator: ACCEL.saveAs, disabled: activeTab?.kind !== "query", action: () => void saveActiveScript(true) },
        { separator: true },
        { label: "退出", action: () => windowControl("close") }
      ]
    },
    {
      label: "编辑",
      items: [
        { label: "格式化 SQL", accelerator: ACCEL.format, disabled: activeTab?.kind !== "query", action: () => void formatActiveQuery() },
        { separator: true },
        { label: "扩展选中", accelerator: ACCEL.expand, disabled: activeTab?.kind !== "query", action: () => editorRef.current?.trigger("menu", "editor.action.smartSelect.expand", null) },
        { label: "收窄选中", accelerator: ACCEL.shrink, disabled: activeTab?.kind !== "query", action: () => editorRef.current?.trigger("menu", "editor.action.smartSelect.shrink", null) },
        { separator: true },
        { label: "全选", accelerator: ACCEL.selectAll, action: () => selectAllInPage() },
        { label: "复制", accelerator: ACCEL.copy, action: () => editorRef.current?.trigger("menu", "editor.action.clipboardCopyAction", null) },
        { label: "粘贴", accelerator: ACCEL.paste, action: () => editorRef.current?.trigger("menu", "editor.action.clipboardPasteAction", null) }
      ]
    },
    {
      label: "视图",
      items: [
        { label: showSide ? "隐藏对象导航" : "显示对象导航", action: () => setShowSide(value => !value) },
        { label: showInfo ? "隐藏对象信息" : "显示对象信息", action: () => setShowInfo(value => !value) },
        { separator: true },
        { label: "浅色主题", action: () => setTheme("light") },
        { label: "深色主题", action: () => setTheme("dark") },
        { label: "跟随系统", action: () => setTheme("system") }
      ]
    },
    {
      label: "数据库",
      items: [
        { label: "断开连接", disabled: !session, action: () => void disconnect() },
        { separator: true },
        {
          label: "表列表",
          disabled: !session || (!activeNode && roots.length === 0),
          action: () => session && void openTableList(activeNode ?? roots[0])
        },
        { label: "新建表…", disabled: !session, action: () => void createTableDraft() },
        { label: "脚本列表", disabled: !session, action: () => void openScriptList() },
        { label: "刷新对象", disabled: !session, action: () => void refreshObjectList(activeNode ?? roots[0]) }
      ]
    },
    {
      label: "查询",
      items: [
        { label: "新建查询", action: createQueryTab },
        { label: "新建脚本…", disabled: !session, action: () => void createScript() },
        { separator: true },
        { label: "执行", accelerator: ACCEL.run, disabled: activeTab?.kind !== "query", action: () => void runSelectionOrAll() },
        { label: "停止", disabled: !activeTab?.running, action: () => void stopQuery() },
        { label: "执行计划", disabled: activeTab?.kind !== "query", action: () => void explainActiveQuery() }
      ]
    },
    {
      label: "工具",
      items: [
        { label: "连接管理…", action: () => setManagerOpen(true) },
        { label: "新建连接…", action: () => setConnectionDialog({ mode: "new" }) },
        { separator: true },
        { label: "选项…", action: () => setOptionsOpen(true) }
      ]
    },
    {
      label: "帮助",
      items: [
        {
          label: "关于 Valkyrie",
          action: () => setMessageBox({
            title: "关于 Valkyrie",
            message: "Valkyrie 数据库客户端\nElectron 界面 + Java 数据层\n版本 0.1.0"
          })
        }
      ]
    }
  ];

  return (
    <div className={`app${settings.gridZebra ? "" : " no-zebra"}${settings.gridRowNumbers ? "" : " no-rownum"}${IS_MAC ? " is-mac" : ""}${themeResolved === "dark" ? " is-dark" : " is-light"}`}>
      <header className="titlebar">
        <span className="brand">VALKYRIE</span>
        <span className="brand-sub">
          {session ? `${session.name} · ${currentDatabase}` : "数据库客户端"}
        </span>
        <span className="titlebar-spacer" />
        <span className="titlebar-hint">{KEY.run} 执行 · {KEY.format} 格式化</span>
        <span className="window-buttons">
          <button type="button" className="win-btn" aria-label="最小化" onClick={() => windowControl("minimize")}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button
            type="button"
            className="win-btn"
            aria-label={maximized ? "还原" : "最大化"}
            onClick={() => windowControl("maximize")}
          >
            {maximized
              ? <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 3h7v7H0zM3 3V0h7v7H7" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
              : <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>}
          </button>
          <button type="button" className="win-btn is-close" aria-label="关闭" onClick={() => windowControl("close")}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
        </span>
      </header>

      <nav className="menubar" onMouseLeave={() => setOpenMenu(null)}>
        {menus.map(menu => (
          <MenuButton
            key={menu.label}
            label={menu.label}
            entries={menu.items}
            open={openMenu === menu.label}
            onOpenChange={open => setOpenMenu(open ? menu.label : null)}
          />
        ))}
        <span className="menubar-right">{status}</span>
      </nav>

      <div className="toolbar">
        <button type="button" className="tbtn" onClick={() => void refreshConnections()}>
          <Icon name="refresh" />连接
        </button>
        <button type="button" className="tbtn" onClick={createQueryTab}>
          <Icon name="terminal" />新建查询
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={!session || (!activeNode && roots.length === 0)}
          title="打开当前对象的表列表"
          onClick={() => session && void openTableList(activeNode ?? roots[0])}
        >
          <Icon name="list" />表列表
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={!session}
          title="查看 / 管理本地 SQL 脚本"
          onClick={() => void openScriptList()}
        >
          <Icon name="code" />脚本
        </button>
        <span className="tbtn-push" aria-hidden="true" />
        <span className="toolbar-text">行数限制 {activeTab && activeTab.kind === "data" ? activeTab.pageSize : settings.pageSize}</span>
        <span className="tbtn-sep" aria-hidden="true" />
        <button type="button" className="tbtn" onClick={() => setTheme(NEXT_THEME[theme])}>
          <Icon name={THEME_ICON[theme]} />
          {THEME_LABEL[theme]}
        </button>
      </div>

      <Group
        orientation="horizontal"
        id="valkyrie-columns"
        defaultLayout={columnsLayout.defaultLayout}
        onLayoutChanged={columnsLayout.onLayoutChanged}
        className={`work-body${showSide ? "" : " no-side"}${showInfo ? "" : " no-info"}`}
      >
        <Panel id="side" className="side-panel" defaultSize="23%" minSize="13%" maxSize="36%">
        <aside className="side">
          <div className="side-head">
            <span className="side-title">对象导航</span>
            <button type="button" className="icon-btn" aria-label="刷新连接" onClick={() => void refreshConnections()}>
              <Icon name="refresh" size={13} />
            </button>
          </div>

          <div className="side-search">
            <Icon name="search" size={13} />
            <input
              type="search"
              placeholder="搜索对象…"
              aria-label="搜索数据库对象"
              value={treeFilter}
              onChange={event => setTreeFilter(event.target.value)}
            />
          </div>

          <Tree
            root={treeRoot}
            childrenMap={treeChildren}
            expanded={expanded}
            loading={loadingNodes}
            activeId={activeNode?.id ?? null}
            filter={treeFilter}
            onToggle={node => void toggleNode(node)}
            onSelect={selectTreeNode}
            onActivate={activateNode}
            onOpenData={openTableData}
            onDesign={openTableDesign}
            onCopyName={node => void navigator.clipboard?.writeText(node.label)}
            menuFor={buildContextMenu}
          />
        </aside>
        </Panel>

        <Separator className="splitter splitter-v" aria-label="调整对象树宽度" />

        <Panel id="work" className="work-panel" minSize="30%">
        <main className="work-main">
          <div className={`work-tabs${tabs.length === 0 ? " is-hidden" : ""}`}>
            {tabs.map(tab => (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                className={`work-tab${tab.id === activeTabId ? " is-active" : ""}`}
                onContextMenu={event => {
                  event.preventDefault();
                  void popupNativeMenu(buildTabMenuEntries(tab.id));
                }}
                onAuxClick={event => {
                  /* 中键关闭 */
                  if (event.button === 1) {
                    event.preventDefault();
                    closeTab(tab.id);
                  }
                }}
              >
                <button
                  type="button"
                  className="work-tab-main"
                  onClick={() => setActiveTabId(tab.id)}
                  title={tab.title}
                >
                  <Icon
                    name={tab.kind === "query" ? "terminal"
                      : tab.kind === "data" ? "table"
                        : tab.kind === "objects" ? (tab.view === "scripts" ? "code" : "list")
                          : "columns"}
                    size={13}
                  />
                  <span className="work-tab-title">{tab.title}</span>
                  {/* 脚本有未保存的修改 → 标题后面点一个小圆点 */}
                  {isScriptDirty(tab) && <span className="work-tab-dot" title="有未保存的修改" aria-label="有未保存的修改" />}
                </button>
                {/* 「对象」列常驻，不给关闭按钮 */}
                {tab.kind !== "objects" && (
                  <button
                    type="button"
                    className="work-tab-close"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="work-tab-add" aria-label="新建查询" onClick={createQueryTab}>
              <Icon name="plus" size={13} />
            </button>
          </div>

          {tabs.length === 0 && (
            <div className="welcome">
              <div className="welcome-title">没有打开的标签</div>
              <div className="welcome-hint">在左侧双击表打开数据，或新建一个查询控制台</div>
              <div className="welcome-actions">
                <button type="button" className="tbtn is-primary" onClick={createQueryTab}>
                  <Icon name="terminal" />新建查询
                </button>
                <button type="button" className="tbtn" onClick={() => void refreshConnections()}>
                  <Icon name="refresh" />刷新连接
                </button>
              </div>
            </div>
          )}

          <div className={`pane-toolbar${tabs.length === 0 ? " is-hidden" : ""}`}>
            {activeTab?.kind === "query" && (
              <>
                <button
                  type="button"
                  /* 执行中只置灰，不加转圈 / 闪烁动画（进度看状态栏与日志页） */
                  className="tbtn is-primary"
                  disabled={activeTab.running}
                  title={`执行 (${KEY.run})`}
                  onClick={() => void runSelectionOrAll()}
                >
                  <Icon name="play" />执行
                </button>
                <button
                  type="button"
                  className="tbtn is-danger"
                  disabled={!activeTab.running}
                  onClick={() => void stopQuery()}
                >
                  <Icon name="stop" />停止
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <button type="button" className="tbtn" onClick={() => void formatActiveQuery()}>
                  <Icon name="code" />格式化
                </button>
                <span className="toolbar-text">
                  {activeTab.running ? "执行中…" : `${activeTab.sql.split("\n").length} 行`}
                </span>

                {/* 连接 / 数据库 / 模式 / 表：SQL 执行上下文 */}
                <span className="path-selector">
                  <span className="path-item">
                    <label htmlFor={`path-conn-${activeTab.id}`}>连接</label>
                    <Select
                      id={`path-conn-${activeTab.id}`}
                      value={session?.name ?? ""}
                      disabled={connections.length === 0}
                      options={[
                        { value: "", label: "未连接" },
                        ...connections.map(connection => ({
                          value: connection.name,
                          label: connection.name,
                          logo: connection.type
                        }))
                      ]}
                      onChange={name => {
                        const connection = connections.find(item => item.name === name);

                        if (connection) {
                          /* 标签记住新连接，之后断开也还能用它的补全快照 */
                          updateQueryPath({ connection: name, catalog: undefined, schema: undefined, table: undefined });
                          void openConnection(connection);
                        }
                      }}
                    />
                  </span>

                  <span className="path-item">
                    <label htmlFor={`path-catalog-${activeTab.id}`}>数据库</label>
                    <Select
                      id={`path-catalog-${activeTab.id}`}
                      icon="layers"
                      value={activeTab.path.catalog ?? ""}
                      disabled={catalogOptions.length === 0}
                      options={catalogOptions.length === 0
                        ? [{ value: "", label: "—" }]
                        : catalogOptions.map(node => ({ value: node.label, label: node.label }))}
                      onChange={catalog => updateQueryPath({ catalog, schema: undefined, table: undefined })}
                    />
                  </span>

                  <span className="path-item">
                    <label htmlFor={`path-schema-${activeTab.id}`}>模式</label>
                    <Select
                      id={`path-schema-${activeTab.id}`}
                      icon="folder"
                      value={activeTab.path.schema ?? ""}
                      disabled={schemaOptions.length === 0}
                      options={[
                        { value: "", label: schemaOptions.length === 0 ? "—" : "全部" },
                        ...schemaOptions.map(node => ({ value: node.label, label: node.label }))
                      ]}
                      onChange={schema => updateQueryPath({ schema: schema || undefined, table: undefined })}
                    />
                  </span>

                  <span className="path-item">
                    <label htmlFor={`path-table-${activeTab.id}`}>表</label>
                    <Select
                      id={`path-table-${activeTab.id}`}
                      icon="table"
                      value={activeTab.path.table ?? ""}
                      disabled={tableNodes.length === 0}
                      options={[
                        { value: "", label: tableNodes.length === 0 ? "—" : `${tableNodes.length} 张表` },
                        ...tableNodes.map(node => ({ value: node.label, label: node.label }))
                      ]}
                      onChange={table => {
                        updateQueryPath({ table: table || undefined });

                        /* 选表即打开数据页，和 Navicat 里双击表一致 */
                        const node = tableNodes.find(item => item.label === table);
                        if (node) openTableData(node);
                      }}
                    />
                  </span>
                </span>
              </>
            )}

            {activeTab?.kind === "objects" && activeTab.view === "scripts" && (
              <>
                <button type="button" className="tbtn" onClick={() => void createScript()}>
                  <Icon name="plus" />新建脚本
                </button>
                <button
                  type="button"
                  className="tbtn"
                  disabled={scriptSelections.length === 0}
                  onClick={() => scriptSelections.forEach(script => void openScriptFile(script))}
                >
                  <Icon name="terminal" />打开
                </button>
                <button
                  type="button"
                  className="tbtn"
                  disabled={scriptSelections.length !== 1}
                  onClick={() => scriptSelections[0] && void renameScriptFile(scriptSelections[0])}
                >
                  <Icon name="pencil" />重命名
                </button>
                <button
                  type="button"
                  className="tbtn"
                  disabled={scriptSelections.length !== 1}
                  onClick={() => scriptSelections[0] && void revealPath(scriptSelections[0].path)}
                >
                  <Icon name="folderOpen" />在文件夹中显示
                </button>
                <button
                  type="button"
                  className="tbtn is-danger"
                  disabled={scriptSelections.length === 0}
                  onClick={() => void deleteScriptFiles(scriptSelections)}
                >
                  <Icon name="trash" />删除
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={`tbtn${activeTab.loading ? " is-busy" : ""}`}
                  disabled={activeTab.loading}
                  onClick={() => void refreshScriptList(activeTab.id)}
                >
                  <Icon name="refresh" />刷新
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <span className="toolbar-text">{activeTab.scripts.length} 个脚本</span>
                <span className="tbtn-push" aria-hidden="true" />
                <span className="toolbar-search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={scriptFilter}
                    placeholder="搜索脚本名 / 数据库…"
                    aria-label="搜索脚本"
                    onChange={event => setScriptFilter(event.target.value)}
                  />
                </span>
              </>
            )}

            {activeTab?.kind === "objects" && activeTab.view === "tables" && (
              <>
                <button
                  type="button"
                  className="tbtn"
                  onClick={() => void createTableDraft(activeTab.node.catalog ?? activeTab.node.label)}
                >
                  <Icon name="plus" />新建表
                </button>
                <button
                  type="button"
                  className="tbtn"
                  disabled={objectSelections.length === 0}
                  onClick={() => objectSelections.forEach(node => openTableData(node))}
                >
                  <Icon name="table" />打开表
                </button>
                <button
                  type="button"
                  className="tbtn"
                  disabled={objectSelections.length === 0}
                  onClick={() => objectSelections.forEach(node => openTableDesign(node))}
                >
                  <Icon name="columns" />设计表
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={`tbtn${pending === "tableList" ? " is-busy" : ""}`}
                  disabled={pending === "tableList"}
                  onClick={() => void refreshTableList(activeTab.id, activeTab.node)}
                >
                  <Icon name="refresh" />刷新
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <span className="toolbar-text">{activeTab.tables.length} 张表</span>
                <span className="tbtn-push" aria-hidden="true" />
                <span className="toolbar-search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={tableFilter}
                    placeholder="搜索表名 / 注释…"
                    aria-label="搜索数据表"
                    onChange={event => setTableFilter(event.target.value)}
                  />
                </span>
              </>
            )}

            {activeTab?.kind === "data" && (
              <>
                <button
                  type="button"
                  className={`tbtn${pending === "loadPage" ? " is-busy" : ""}`}
                  disabled={pending === "loadPage"}
                  onClick={() => void loadPage(activeTab.id, activeTab.node, activeTab.page, activeTab.pageSize).then(() => setGridFlash(previous => previous + 1))}
                >
                  <Icon name="refresh" />刷新
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <span className="toolbar-text">
                  第 {(activeTab.result?.offset ?? activeTab.page * activeTab.pageSize) + 1} – {(activeTab.result?.offset ?? 0) + rows.length} 行
                </span>
                <span className="tbtn-push" aria-hidden="true" />
                <button
                  type="button"
                  className="tbtn"
                  disabled={activeTab.page === 0}
                  onClick={() => void loadPage(activeTab.id, activeTab.node, activeTab.page - 1, activeTab.pageSize)}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="tbtn"
                  disabled={rows.length < activeTab.pageSize}
                  onClick={() => void loadPage(activeTab.id, activeTab.node, activeTab.page + 1, activeTab.pageSize)}
                >
                  下一页
                </button>
              </>
            )}

            {activeTab?.kind === "design" && (
              <>
                <span className="toolbar-text">
                  {activeTab.node.catalog ?? ""} · {activeTab.node.label}
                </span>
                <span className="tbtn-push" aria-hidden="true" />
                <button type="button" className="tbtn" onClick={() => void loadDesign(activeTab.id, activeTab.node)}>
                  <Icon name="refresh" />重新读取
                </button>
              </>
            )}
          </div>

          {/* 编辑器常驻挂载（隐藏时不销毁 Monaco 实例） */}
          <Group
            orientation="vertical"
            id="valkyrie-rows"
            defaultLayout={rowsLayout.defaultLayout}
            onLayoutChanged={rowsLayout.onLayoutChanged}
            className="work-rows"
          >
            <Panel
              id="editor"
              panelRef={editorPanelRef}
              className={`editor-panel${activeTab?.kind === "query" ? "" : " is-hidden"}`}
              defaultSize="80%"
              minSize="10%"
              collapsible
              collapsedSize="0%"
            >
              <div className="editor-wrap">
                {/* 右键菜单与 FX 版一致：运行已选择 / 美化 / 复制 / 剪切 / 粘贴 / 全选 / 注释 / 大小写 */}
                <div
                  className="editor"
                  ref={editorContainer}
                  onContextMenu={event => {
                    event.preventDefault();
                    const hasSelection = Boolean(editorRef.current && !editorRef.current.getSelection()?.isEmpty());

                    void popupNativeMenu(buildEditorMenuEntries(hasSelection));
                  }}
                />
              </div>
            </Panel>

            {activeTab?.kind === "query" && <Separator className="splitter splitter-h" aria-label="调整编辑器高度" />}

            <Panel id="result" className="result-panel" defaultSize="20%" minSize="12%">
          <div className={`result${tabs.length === 0 ? " is-hidden" : ""}`}>
            <div className={`result-tabs${pageTab ? " is-hidden" : ""}`}>
              <button type="button" className={`result-tab${resultPane === "grid" ? " is-active" : ""}`} onClick={() => setResultPane("grid")}>
                结果集
                {rows.length > 0 && <span className="result-count">{rows.length}</span>}
              </button>
              <button type="button" className={`result-tab${resultPane === "msg" ? " is-active" : ""}`} onClick={() => setResultPane("msg")}>
                消息
              </button>
              {/* 没有结果集的查询不展示执行计划 */}
              {activeTab?.kind === "query" && (activeTab.result?.hasResultSet || activeTab.plan) && (
                <button type="button" className={`result-tab${resultPane === "plan" ? " is-active" : ""}`} onClick={() => void explainActiveQuery()}>
                  执行计划
                </button>
              )}
              <button type="button" className={`result-tab${resultPane === "log" ? " is-active" : ""}`} onClick={() => setResultPane("log")}>
                日志
              </button>
              <span className="result-tabs-push">
                {activeTab?.kind === "query" && activeTab.result?.hasResultSet && (
                  <span className="toolbar-text">
                    {rows.length} 行 · {columns.length} 列{lastCost != null ? ` · ${lastCost} ms` : ""}
                  </span>
                )}
              </span>
            </div>

            {resultPane === "grid" && currentResult?.hasResultSet && activeTab?.kind !== "design" && (
              <div className="grid-tools">
                <button
                  type="button"
                  className={`tbtn${pending === "result.insert" ? " is-busy" : ""}`}
                  disabled={!currentResult.addable}
                  onClick={() => void runResultAction("result.insert", {}, "已新增一行")}
                >
                  <Icon name="plus" />新增行
                </button>
                <button
                  type="button"
                  className={`tbtn${pending === "result.delete" ? " is-busy" : ""}`}
                  disabled={!currentResult.editable || !gridSelection}
                  onClick={() => gridSelection && void runResultAction("result.delete", { rows: selectionRows(gridSelection) }, "已删除选中行")}
                >
                  <Icon name="trash" />删除行
                </button>
                <button
                  type="button"
                  className={`tbtn${pending === "result.setNull" ? " is-busy" : ""}`}
                  disabled={!currentResult.editable || !gridSelection}
                  onClick={() => gridSelection && void runResultAction("result.setNull", { rows: selectionRows(gridSelection), cols: selectionCols(gridSelection) }, "已设置为 NULL")}
                >
                  设为 NULL
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={`tbtn is-primary${pending === "result.commit" ? " is-busy" : ""}`}
                  disabled={!currentResult.dirty}
                  onClick={() => void runResultAction("result.commit", {}, "修改已提交")}
                >
                  <Icon name="check" />提交修改
                </button>
                <button
                  type="button"
                  className={`tbtn${pending === "result.rollback" ? " is-busy" : ""}`}
                  disabled={!currentResult.dirty}
                  onClick={() => void runResultAction("result.rollback", {}, "已回滚未提交的修改")}
                >
                  <Icon name="refresh" />回滚
                </button>
                <span className="tbtn-sep" aria-hidden="true" />
                <button
                  type="button"
                  className={`tbtn${pending === "result.reload" ? " is-busy" : ""}`}
                  onClick={() => void runResultAction("result.reload", {}, "已刷新")}
                >
                  <Icon name="refresh" />刷新
                </button>
                <button type="button" className="tbtn" onClick={() => void exportResult("csv")}>
                  <Icon name="csv" />导出 CSV
                </button>
                <button type="button" className="tbtn" onClick={() => void exportResult("excel")}>
                  <Icon name="excel" />导出 Excel
                </button>
                <span className="tbtn-push" aria-hidden="true" />
                {/* 全表搜索：按任意单元格匹配过滤，命中的关键字在表格里黄底标出 */}
                <span className="toolbar-search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={gridSearch}
                    placeholder="搜索当前结果集…"
                    aria-label="搜索当前结果集"
                    onChange={event => setGridSearch(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Escape")
                        setGridSearch("");
                    }}
                  />
                </span>
                {searchingGrid && (
                  <span className="toolbar-text">
                    命中 {gridHits ?? 0} / {rows.length} 行
                  </span>
                )}
                <span className="toolbar-text">
                  {currentResult.editable ? "可编辑" : "只读"}{searchingGrid ? " · 改动只作用于可见行" : ""}
                  {currentResult.dirty
                    ? ` · ${activeTab && "pending" in activeTab ? activeTab.pending ?? 0 : 0} 条未提交修改`
                    : ""}
                </span>
              </div>
            )}

            <div className="result-body">
              {activeTab?.kind === "objects" && activeTab.view === "tables" && (
                <div className="table-list-host">
                    <TableList
                      tables={activeTab.tables}
                      loading={activeTab.loading}
                      filter={tableFilter}
                      flashToken={listFlash}
                      selectedNames={tableSelection}
                      onSelectionChange={names => {
                        setTableSelection(names);

                        /* 单选时同步对象信息面板 */
                        const node = names.length === 1
                          ? activeTab.tables.find(item => item.label === names[0]) ?? null
                          : null;

                        if (node)
                          setActiveNode(node);
                      }}
                      onOpen={openTableData}
                      onContextMenu={node => void popupNativeMenu(buildObjectMenu(node))}
                    />
                </div>
              )}

              {activeTab?.kind === "objects" && activeTab.view === "scripts" && (
                <div className="table-list-host">
                  <ScriptList
                    scripts={activeTab.scripts}
                    loading={activeTab.loading}
                    filter={scriptFilter}
                    flashToken={scriptFlash}
                    selectedPaths={scriptSelection}
                    onSelectionChange={setScriptSelection}
                    onOpen={script => void openScriptFile(script)}
                    onContextMenu={script => void popupNativeMenu(buildScriptMenuEntries(script))}
                  />
                </div>
              )}

              {resultPane === "grid" && activeTab?.kind === "design" && (
                <TableDesign
                  table={activeTab.node.label}
                  columns={activeTab.columns}
                  indexes={activeTab.indexes}
                  ddl={activeTab.ddl}
                  loading={activeTab.loading}
                  onApply={ddl => void applyTableDdl(activeTab.id, activeTab.node, ddl)}
                />
              )}

              {resultPane === "grid" && !pageTab && activeTab?.kind !== "design" && (
                <div className="grid-host">
                    <ResultGrid
                      columns={columns}
                      rows={rows}
                      flashToken={gridFlash}
                      fontSize={settings.gridFontSize}
                      onContextMenu={() => void popupNativeMenu(gridMenuEntries)}
                      offset={activeTab?.kind === "data" ? activeTab.result?.offset ?? 0 : 0}
                      editable={Boolean(currentResult?.editable)}
                      dirtyRows={activeTab && "dirtyRows" in activeTab ? activeTab.dirtyRows : []}
                      search={gridKeyword}
                      onSearchHitsChange={setGridHits}
                      onCellCommit={(row, col, value) => void runResultAction("result.update", { row, col, value }, "已修改（未提交）")}
                      onSelectionChange={setGridSelection}
                    />
                </div>
              )}

              {resultPane === "msg" && !pageTab && (
                <div className="console">
                  {activeTab?.messages.length
                    ? activeTab.messages.map((line, index) => <div key={index}>{line}</div>)
                    : <span className="empty">暂无消息</span>}
                </div>
              )}

              {resultPane === "plan" && !pageTab && (
                <ResultGrid
                  columns={activeTab?.kind === "query" ? activeTab.plan?.columns ?? [] : []}
                  rows={activeTab?.kind === "query" ? activeTab.plan?.rows ?? [] : []}
                />
              )}

              {/* 日志面板常驻（切到别的页时只是隐藏），筛选、搜索、滚动位置都能保住 */}
              {!pageTab && (
                <LogConsole
                  records={logs}
                  active={resultPane === "log"}
                  onClear={() => setLogs([])}
                  onCopy={text => void copyText(text)}
                />
              )}
            </div>
          </div>
            </Panel>
          </Group>
        </main>
        </Panel>

        <Separator className="splitter splitter-v" aria-label="调整对象信息宽度" />

        <Panel id="info" className="info-panel" defaultSize="19%" minSize="12%" maxSize="30%">
        <aside className="info">
          <div className="side-head">
            <span className="side-title">对象信息</span>
          </div>
          <ObjectInfo
            node={activeNode}
            connectionName={session?.name ?? null}
            product={session?.product ?? null}
            columns={infoColumns}
            indexes={infoIndexes}
            onOpenData={openTableData}
            onDesign={openTableDesign}
          />
        </aside>
        </Panel>
      </Group>

      <footer className="statusbar">
        <span className="status-item">
          <span className={`status-dot${session ? " is-on" : ""}`} aria-hidden="true" />
          {session?.name ?? "未连接"}
        </span>
        <span className="status-item">{productLabel}</span>
        <span className="status-item">{currentDatabase}</span>
        <span className="status-item">{tabKindLabel(activeTab?.kind)}</span>
        <span className="status-item">结果 {rows.length} 行{lastCost != null ? ` / ${lastCost} ms` : ""}</span>
        <span className="status-spacer" />
        <span className="status-item">{status}</span>
        {busy > 0 && (
          <span className="status-item is-busy">
            <span className="spinner" aria-hidden="true" />处理中
          </span>
        )}
      </footer>

      {confirmDialog && (
        <Dialog title={confirmDialog.title} onClose={() => answerConfirm(false)}>
          <div className="modal-body">{confirmDialog.message}</div>
          <div className="modal-actions">
            <button type="button" className="mini-btn" onClick={() => answerConfirm(false)}>取消</button>
            <button
              type="button"
              className={`mini-btn${confirmDialog.danger ? " is-danger" : " is-default"}`}
              onClick={() => answerConfirm(true)}
            >
              确定
            </button>
          </div>
        </Dialog>
      )}

      {connectionDialog && (
        <ConnectionDialog
          mode={connectionDialog.mode}
          source={connectionDialog.connection}
          onClose={() => setConnectionDialog(null)}
          onSaved={async (name, options) => {
            setConnectionDialog(null);
            await refreshConnections();
            setStatus(`已保存连接 ${name}`);

            /* 「保存并连接」：直接连上，省得再去树里点一次 */
            if (options?.connect) {
              const connection = { name };
              const saved = (await invoke<{ connections: SavedConnection[] }>("connections.list")).connections
                .find(item => item.name === connection.name);

              if (saved)
                await openConnection(saved);
            }
          }}
        />
      )}

      {managerOpen && (
        <ConnectionManager
          connections={connections}
          connected={session?.name ?? null}
          onClose={() => setManagerOpen(false)}
          onOpen={connection => {
            setManagerOpen(false);
            void openConnection(connection);
          }}
          onEdit={(mode, connection) => setConnectionDialog({ mode, connection: connection ?? null })}
          onDelete={connection => void deleteConnection(connection.name)}
          onRefresh={() => void refreshConnections()}
        />
      )}

      {optionsOpen && (
        <OptionsDialog
          settings={settings}
          theme={theme}
          onChange={updateSettings}
          onThemeChange={setTheme}
          onClose={() => setOptionsOpen(false)}
        />
      )}

      {messageBox && (
        <Dialog
          title={messageBox.title}
          role="alertdialog"
          onClose={() => setMessageBox(null)}
        >
          <div className="modal-body pre-wrap">{messageBox.message}</div>
          <div className="modal-actions">
            <button type="button" className="mini-btn is-default" onClick={() => setMessageBox(null)}>确定</button>
          </div>
        </Dialog>
      )}

      {textDialog && (
        <Dialog title={textDialog.title} onClose={() => answerText(null)}>
          <div className="modal-body">
            <input
              className="dialog-input"
              autoFocus
              defaultValue={textDialog.value}
              aria-label={textDialog.title}
              onKeyDown={event => {
                if (event.key === "Enter")
                  answerText((event.target as HTMLInputElement).value);
                else if (event.key === "Escape")
                  answerText(null);
              }}
              /* 打开即聚焦并全选默认值，改名时直接输入就能覆盖 */
              ref={input => {
                input?.focus();
                input?.select();
              }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="mini-btn" onClick={() => answerText(null)}>取消</button>
            <button
              type="button"
              className="mini-btn is-default"
              onClick={event => {
                const input = (event.currentTarget.closest(".modal") as HTMLElement)?.querySelector(".dialog-input") as HTMLInputElement | null;
                answerText(input?.value ?? null);
              }}
            >
              确定
            </button>
          </div>
        </Dialog>
      )}

      <Toaster
        position="bottom-right"
        theme={theme === "dark" ? "dark" : "light"}
        closeButton
        toastOptions={{ className: "vk-toast" }}
      />
    </div>
  );
}

/* ------------------------------ 辅助 ------------------------------ */

function tableParams(sessionId: string, node: SchemaNode): Record<string, unknown> {
  return {
    sessionId,
    table: node.table?.name ?? node.label,
    catalog: node.catalog,
    schema: node.schema
  };
}

/** SQL 字面量：NULL 原样，其余单引号转义后包起来 */
function sqlLiteral(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

/** 状态栏右侧的页面类型文案 */
function tabKindLabel(kind: WorkTab["kind"] | undefined): string {
  switch (kind) {
    case "query":
      return "查询控制台";
    case "data":
      return "数据浏览";
    case "design":
      return "表结构";
    case "objects":
      return "对象列表";
    default:
      return "就绪";
  }
}

/** 按数据库类型生成建表草稿（只是模板，用户可随意改） */
function createTableTemplate(name: string, type: string): string {
  switch (type) {
    case "postgresql":
      return `CREATE TABLE ${name} (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(64) NOT NULL\n);\n`;
    case "sqlite":
      return `CREATE TABLE ${name} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name VARCHAR(64) NOT NULL\n);\n`;
    case "dm":
      return `CREATE TABLE ${name} (\n  id INT IDENTITY(1, 1) PRIMARY KEY,\n  name VARCHAR(64) NOT NULL\n);\n`;
    case "redis":
      return `-- Redis 没有建表语句，这里按键值对思路写两句备注：\n-- SET ${name}:1 "value"\n-- HSET ${name}:1 field "value"\n`;
    default:
      return `CREATE TABLE \`${name}\` (\n  \`id\` INT NOT NULL AUTO_INCREMENT,\n  \`name\` VARCHAR(64) NOT NULL,\n  PRIMARY KEY (\`id\`)\n);\n`;
  }
}

/** 数据层返回的补全类型 → Monaco 内置弹窗的图标类型 */
function completionKind(kind: string): monaco.languages.CompletionItemKind {
  switch (kind) {
    case "Function":
      return monaco.languages.CompletionItemKind.Function;
    case "Operator":
      return monaco.languages.CompletionItemKind.Operator;
    case "Class":
      return monaco.languages.CompletionItemKind.Class;
    case "Field":
      return monaco.languages.CompletionItemKind.Field;
    case "Module":
      return monaco.languages.CompletionItemKind.Module;
    case "Snippet":
      return monaco.languages.CompletionItemKind.Snippet;
    default:
      return monaco.languages.CompletionItemKind.Keyword;
  }
}

/**
 * 维护"有未提交修改"的行号：编辑单元格时累加，提交/回滚/刷新/删除后清空。
 */
function resolveDirtyRows(method: string, params: Record<string, unknown>, current: number[]): number[] {
  if (method === "result.update") {
    const row = Number(params.row);
    return current.includes(row) ? current : [...current, row];
  }

  if (method === "result.setNull") {
    const rows = Array.isArray(params.rows) ? params.rows.map(Number) : [];
    return [...new Set([...current, ...rows])];
  }

  return [];
}

function formatProgress(event: ProgressEvent): string {
  const detail = event.detail ?? "";
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  switch (event.kind) {
    case "execute":
      return `[${time}] execute  ${detail}`;
    case "query":
      return `[${time}] query    ${detail}`;
    case "skip":
      return `[${time}] skip     ${detail}`;
    case "update":
      return `[${time}] update   ${detail}`;
    case "rows":
      return `[${time}] 影响行数 ${detail}`;
    case "cost":
      return `[${time}] 耗时 ${detail} ms`;
    default:
      return "";
  }
}

/** 语句级报错也写进日志面板：格式与执行日志一致 */
function formatErrorLog(message: string): string {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  return `[${time}] error    ${message}`;
}
