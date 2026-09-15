import type { SavedConnection, SchemaNode, ScriptFile } from "../api";
import { windowControl } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import type { ConnectionDialogState, MessageBoxState } from "../dialogs/useDialogs";
import type { ThemeMode } from "../settings";
import type { MenuEntry } from "../ui/Menu";
import { DB_TYPES } from "../ui/ConnectionDialog";
import { dbLogoUrl } from "../ui/dbLogo";
import { ACCEL } from "../keys";
import { treeNodeOfTab } from "../tabs/tabHelpers";

/** 菜单构建需要的全部状态与动作（由 App 组装后传入，避免菜单模块反向依赖 domain）。 */
export interface MenuContext {
  expanded: Set<string>;
  openSessions: Record<string, SessionState>;
  connections: SavedConnection[];
  session: SessionState | null;
  activeNode: SchemaNode | null;
  roots: SchemaNode[];
  treeChildren: Record<string, SchemaNode[]>;
  tabs: WorkTab[];
  activeTab: WorkTab | null;
  objectSelections: SchemaNode[];
  scriptSelections: ScriptFile[];
  tableSelection: string[];
  scriptSelection: string[];
  showSide: boolean;
  showInfo: boolean;
  currentConnection: SavedConnection | null;
  editorRef: { current: { trigger: (source: string, handlerId: string, payload: unknown) => void } | null };
  gridCopyRef: { current: () => boolean };
  setShowSide: (updater: (value: boolean) => boolean) => void;
  setShowInfo: (updater: (value: boolean) => boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setConnectionDialog: (state: ConnectionDialogState | null) => void;
  setManagerOpen: (open: boolean) => void;
  setOptionsOpen: (open: boolean) => void;
  setMessageBox: (state: MessageBoxState | null) => void;
  createQueryTab: () => void;
  openAllConnections: () => void;
  closeAllConnections: () => void;
  refreshConnections: () => void;
  disconnect: (name?: string) => void;
  deleteConnection: (name: string) => void;
  toggleNode: (node: SchemaNode) => void;
  refreshNode: (node: SchemaNode) => void;
  refreshObjectList: (node: SchemaNode) => void;
  openTableList: (node: SchemaNode) => void;
  createTableDraft: (catalogHint?: string) => void;
  exportTableSql: (node: SchemaNode, withData: boolean) => void;
  exportDatabaseSql: (node: SchemaNode, withData: boolean) => void;
  openTableData: (node: SchemaNode) => void;
  openTableDesign: (node: SchemaNode) => void;
  copyDdl: (node: SchemaNode) => void;
  clearTable: (node: SchemaNode) => void;
  dropTable: (node: SchemaNode) => void;
  dropTables: (nodes: SchemaNode[]) => void;
  openScript: (node: SchemaNode) => void;
  renameScript: (node: SchemaNode) => void;
  deleteScript: (node: SchemaNode) => void;
  openScriptList: () => void;
  createScript: (catalogHint?: string) => void;
  openScriptFile: (file: { name: string; catalog: string; connection?: string }) => void;
  deleteScriptFiles: (files: { name: string; catalog: string }[]) => void;
  renameScriptFile: (file: { name: string; catalog: string }) => void;
  saveActiveScript: (saveAs?: boolean) => void;
  runSelectionOrAll: () => void;
  formatActiveQuery: () => void;
  stopQuery: () => void;
  explainActiveQuery: () => void;
  selectAllInPage: () => void;
  copyText: (text: string) => void;
  revealPath: (path: string) => void;
  closeTabs: (mode: "current" | "left" | "right" | "all", id: string) => void;
  revealTreeNode: (node: SchemaNode) => void;
}

/**
 * 「新建连接」二级菜单：按库类型列出（同 FX 版的 ConnectionMenuBuilder），
 * 带各库品牌 logo；点哪一项就直接开新建连接对话框，并带上该类型与默认端口。
 */
export function newConnectionMenuEntries(ctx: MenuContext): MenuEntry[] {
  return DB_TYPES.map(item => ({
    label: item.label,
    image: dbLogoUrl(item.value) ?? undefined,
    action: () => ctx.setConnectionDialog({ mode: "new", initialType: item.value })
  }));
}

/* 右键菜单：与 JavaFX 版本保持一致 */
export function buildContextMenu(node: SchemaNode, ctx: MenuContext): MenuEntry[] {
  const container = node.kind === "TABLE" && node.hasChildren;
  const isTable = node.kind === "TABLE" && !node.hasChildren && Boolean(node.table);
  const open = ctx.expanded.has(node.id);

  if (node.kind === "ROOT") {
    const openCount = Object.keys(ctx.openSessions).length;

    return [
      { label: "新建连接", icon: "plus", children: newConnectionMenuEntries(ctx) },
      { label: "新建查询", action: ctx.createQueryTab },
      { separator: true },
      {
        label: "打开所有连接",
        disabled: ctx.connections.length === 0 || openCount >= ctx.connections.length,
        action: () => void ctx.openAllConnections()
      },
      {
        label: "关闭所有连接",
        disabled: openCount === 0,
        action: () => void ctx.closeAllConnections()
      },
      { separator: true },
      { label: "刷新连接", action: () => void ctx.refreshConnections() }
    ];
  }

  if (node.kind === "CONNECTION") {
    return [
      {
        label: node.connected ? "关闭连接" : "打开连接",
        /* 关闭连接 = 真正断开：关掉该连接下的数据页 / 设计页 / 对象页 */
        action: () => void (node.connected ? ctx.disconnect(node.label) : ctx.toggleNode(node))
      },
      { label: "新建查询", action: ctx.createQueryTab },
      { separator: true },
      { label: "刷新", action: () => void ctx.refreshNode(node) },
      { separator: true },
      { label: "复制连接名", action: () => void ctx.copyText(node.label) },
      { separator: true },
      {
        label: "编辑连接",
        action: () => {
          const connection = ctx.connections.find(item => item.name === node.label);

          if (connection)
            ctx.setConnectionDialog({ mode: "edit", connection });
        }
      },
      {
        label: "复制连接",
        action: () => {
          const connection = ctx.connections.find(item => item.name === node.label);

          if (connection)
            ctx.setConnectionDialog({ mode: "copy", connection });
        }
      },
      { label: "删除连接", danger: true, action: () => void ctx.deleteConnection(node.label) }
    ];
  }

  if (node.kind === "CATALOG") {
    return [
      { label: open ? "关闭数据库" : "打开数据库", action: () => void ctx.toggleNode(node) },
      { label: "表列表", action: () => void ctx.openTableList(node) },
      { label: "新建表…", action: () => void ctx.createTableDraft(node.label) },
      { label: "新建查询", action: ctx.createQueryTab },
      { separator: true },
      { label: "导出表结构", action: () => void ctx.exportDatabaseSql(node, false) },
      { label: "导出表结构和数据", action: () => void ctx.exportDatabaseSql(node, true) },
      { separator: true },
      { label: "刷新", action: () => void ctx.refreshObjectList(node) },
      { label: "复制名称", action: () => void ctx.copyText(node.label) }
    ];
  }

  if (node.kind === "SCHEMA") {
    return [
      { label: open ? "收起模式" : "展开模式", action: () => void ctx.toggleNode(node) },
      { label: "表列表", action: () => void ctx.openTableList(node) },
      { label: "新建表…", action: () => void ctx.createTableDraft(node.label) },
      { label: "新建查询", action: ctx.createQueryTab },
      { separator: true },
      { label: "导出表结构", action: () => void ctx.exportDatabaseSql(node, false) },
      { label: "导出表结构和数据", action: () => void ctx.exportDatabaseSql(node, true) },
      { separator: true },
      { label: "刷新列表", action: () => void ctx.refreshObjectList(node) },
      { label: "复制名称", action: () => void ctx.copyText(node.label) }
    ];
  }

  if (container) {
    return [
      { label: open ? "收起列表" : "展开列表", action: () => void ctx.toggleNode(node) },
      { label: "表列表", action: () => void ctx.openTableList(node) },
      { label: "新建表…", action: () => void ctx.createTableDraft(node.catalog) },
      { label: "刷新列表", action: () => void ctx.refreshObjectList(node) },
      { label: "新建查询", action: ctx.createQueryTab }
    ];
  }

  if (node.kind === "QUERY") {
    /* 查询脚本文件（容器没有本地路径，脚本文件有） */
    if (node.path) {
      return [
        { label: "打开查询", action: () => void ctx.openScript(node) },
        { separator: true },
        { label: "新建查询", action: ctx.createQueryTab },
        { label: "重命名脚本", action: () => void ctx.renameScript(node) },
        { separator: true },
        { label: "复制脚本名", action: () => void ctx.copyText(node.label) },
        { label: "复制路径", action: () => node.path && void ctx.copyText(node.path) },
        { label: "在文件夹中显示", action: () => node.path && void ctx.revealPath(node.path) },
        { separator: true },
        { label: "删除脚本", danger: true, action: () => void ctx.deleteScript(node) }
      ];
    }

    return [
      { label: "脚本列表", action: () => void ctx.openScriptList() },
      { label: "新建脚本", action: () => void ctx.createScript(node.catalog) },
      { label: "新建查询", action: ctx.createQueryTab },
      { separator: true },
      { label: open ? "收起列表" : "展开列表", action: () => void ctx.toggleNode(node) },
      { label: "刷新列表", action: () => void ctx.refreshNode(node) }
    ];
  }

  if (isTable) {
    return [
      { label: "打开表", action: () => ctx.openTableData(node) },
      { label: "设计表", action: () => ctx.openTableDesign(node) },
      { separator: true },
      { label: "复制表名", action: () => void ctx.copyText(node.label) },
      { label: "复制建表语句", action: () => void ctx.copyDdl(node) },
      { label: "复制查询语句", action: () => void ctx.copyText(`SELECT * FROM ${node.label};`) },
      { separator: true },
      { label: "导出表结构", action: () => void ctx.exportTableSql(node, false) },
      { label: "导出表结构和数据", action: () => void ctx.exportTableSql(node, true) },
      { separator: true },
      { label: "清空表", danger: true, action: () => void ctx.clearTable(node) },
      { label: "删除表", danger: true, action: () => void ctx.dropTable(node) },
      { separator: true },
      { label: "刷新列表", action: () => void ctx.refreshObjectList(node) }
    ];
  }

  return [];
}

/* 对象列（脚本视图）右键菜单：多选时换成批量版本 */
export function buildScriptMenuEntries(script: ScriptFile, ctx: MenuContext): MenuEntry[] {
  const batch = ctx.scriptSelection.length > 1 && ctx.scriptSelection.includes(script.path);

  if (batch) {
    return [
      { label: `打开选中的 ${ctx.scriptSelections.length} 个脚本`, action: () => ctx.scriptSelections.forEach(item => void ctx.openScriptFile(item)) },
      { separator: true },
      { label: `删除选中的 ${ctx.scriptSelections.length} 个脚本`, danger: true, action: () => void ctx.deleteScriptFiles(ctx.scriptSelections) }
    ];
  }

  return [
    { label: "打开", action: () => void ctx.openScriptFile(script) },
    { separator: true },
    { label: "新建脚本", action: () => void ctx.createScript(script.catalog) },
    { label: "重命名", action: () => void ctx.renameScriptFile(script) },
    { separator: true },
    { label: "复制脚本名", action: () => void ctx.copyText(script.name) },
    { label: "复制路径", action: () => void ctx.copyText(script.path) },
    { label: "在文件夹中显示", action: () => void ctx.revealPath(script.path) },
    { separator: true },
    { label: "删除脚本", danger: true, action: () => void ctx.deleteScriptFiles([script]) }
  ];
}

/* 「对象」页右键菜单：多选时换成批量版本 */
export function buildObjectMenu(node: SchemaNode, ctx: MenuContext): MenuEntry[] {
  const batch = ctx.tableSelection.length > 1 && ctx.tableSelection.includes(node.label);

  if (!batch)
    return buildContextMenu(node, ctx);

  return [
    { label: `打开选中的 ${ctx.objectSelections.length} 张表`, action: () => ctx.objectSelections.forEach(item => ctx.openTableData(item)) },
    { label: `设计选中的 ${ctx.objectSelections.length} 张表`, action: () => ctx.objectSelections.forEach(item => ctx.openTableDesign(item)) },
    { separator: true },
    { label: "复制表名", action: () => void ctx.copyText(ctx.tableSelection.join("\n")) },
    { label: "刷新列表", action: () => void ctx.refreshObjectList(node) },
    { separator: true },
    { label: `删除选中的 ${ctx.objectSelections.length} 张表`, danger: true, action: () => void ctx.dropTables(ctx.objectSelections) }
  ];
}

/* 编辑器右键菜单：与 JavaFX 版顺序一致（按右键时的选区状态现算） */
export function buildEditorMenuEntries(hasSelection: boolean, ctx: MenuContext): MenuEntry[] {
  if (ctx.activeTab?.kind !== "query")
    return [];

  return [
    {
      label: "运行已选择",
      accelerator: ACCEL.run,
      icon: "play",
      disabled: !hasSelection || ctx.activeTab.running,
      action: () => void ctx.runSelectionOrAll()
    },
    { label: "美化已选择", icon: "code", action: () => void ctx.formatActiveQuery() },
    { separator: true },
    { label: "复制", accelerator: ACCEL.copy, action: () => ctx.editorRef.current?.trigger("menu", "editor.action.clipboardCopyAction", null) },
    { label: "剪切", accelerator: ACCEL.cut, action: () => ctx.editorRef.current?.trigger("menu", "editor.action.clipboardCutAction", null) },
    { label: "粘贴", accelerator: ACCEL.paste, action: () => ctx.editorRef.current?.trigger("menu", "editor.action.clipboardPasteAction", null) },
    { label: "全选", accelerator: ACCEL.selectAll, action: () => ctx.editorRef.current?.trigger("menu", "editor.action.selectAll", null) },
    { separator: true },
    { label: "注释/取消注释", action: () => ctx.editorRef.current?.trigger("menu", "editor.action.commentLine", null) },
    { label: "转大写", action: () => ctx.editorRef.current?.trigger("menu", "editor.action.transformToUppercase", null) },
    { label: "转小写", action: () => ctx.editorRef.current?.trigger("menu", "editor.action.transformToLowercase", null) }
  ];
}

/* 标签页右键菜单：按被点的那一项现算（系统原生菜单需要即时给出条目） */
export function buildTabMenuEntries(id: string, ctx: MenuContext): MenuEntry[] {
  const index = ctx.tabs.findIndex(tab => tab.id === id);

  if (index < 0)
    return [];

  const tabs = ctx.tabs;
  const node = treeNodeOfTab(tabs[index], ctx.treeChildren);

  return [
    {
      label: "在对象树中定位",
      icon: "locate",
      disabled: !node,
      action: () => node && ctx.revealTreeNode(node)
    },
    { separator: true },
    { label: "关闭", disabled: tabs[index].kind === "objects", action: () => void ctx.closeTabs("current", id) },
    { label: "关闭左侧标签", disabled: index === 0, action: () => void ctx.closeTabs("left", id) },
    { label: "关闭右侧标签", disabled: index === tabs.length - 1, action: () => void ctx.closeTabs("right", id) },
    { separator: true },
    { label: "全部关闭", action: () => void ctx.closeTabs("all", id) }
  ];
}

export function buildAppMenus(ctx: MenuContext): { label: string; items: MenuEntry[] }[] {
  return [
    {
      label: "文件",
      items: [
        { label: "新建连接", icon: "plus", children: newConnectionMenuEntries(ctx) },
        { label: "编辑当前连接…", disabled: !ctx.currentConnection, action: () => ctx.setConnectionDialog({ mode: "edit", connection: ctx.currentConnection }) },
        { label: "复制当前连接…", disabled: !ctx.currentConnection, action: () => ctx.setConnectionDialog({ mode: "copy", connection: ctx.currentConnection }) },
        { label: "连接管理…", action: () => ctx.setManagerOpen(true) },
        { separator: true },
        { label: "删除当前连接", danger: true, disabled: !ctx.currentConnection, action: () => ctx.currentConnection && void ctx.deleteConnection(ctx.currentConnection.name) },
        { separator: true },
        { label: "新建脚本…", disabled: !ctx.session, action: () => void ctx.createScript() },
        { label: "脚本列表", disabled: !ctx.session, action: () => void ctx.openScriptList() },
        { separator: true },
        { label: "保存脚本", accelerator: ACCEL.save, disabled: ctx.activeTab?.kind !== "query", action: () => void ctx.saveActiveScript() },
        { label: "脚本另存为…", accelerator: ACCEL.saveAs, disabled: ctx.activeTab?.kind !== "query", action: () => void ctx.saveActiveScript(true) },
        { separator: true },
        { label: "退出", action: () => windowControl("close") }
      ]
    },
    {
      label: "编辑",
      items: [
        { label: "格式化 SQL", accelerator: ACCEL.format, disabled: ctx.activeTab?.kind !== "query", action: () => void ctx.formatActiveQuery() },
        { separator: true },
        { label: "扩展选中", accelerator: ACCEL.expand, disabled: ctx.activeTab?.kind !== "query", action: () => ctx.editorRef.current?.trigger("menu", "editor.action.smartSelect.expand", null) },
        { label: "收窄选中", accelerator: ACCEL.shrink, disabled: ctx.activeTab?.kind !== "query", action: () => ctx.editorRef.current?.trigger("menu", "editor.action.smartSelect.shrink", null) },
        { separator: true },
        { label: "全选", accelerator: ACCEL.selectAll, action: () => ctx.selectAllInPage() },
        {
          label: "复制",
          accelerator: ACCEL.copy,
          action: () => {
            /* 编辑器里用 Monaco 的复制，结果表有选区就复制成制表符分隔，其余走系统默认 */
            const focused = document.activeElement as HTMLElement | null;

            if (focused?.closest?.(".editor"))
              ctx.editorRef.current?.trigger("menu", "editor.action.clipboardCopyAction", null);
            else if (focused?.closest?.("input, textarea") || !ctx.gridCopyRef.current())
              document.execCommand?.("copy");
          }
        },
        { label: "粘贴", accelerator: ACCEL.paste, action: () => ctx.editorRef.current?.trigger("menu", "editor.action.clipboardPasteAction", null) }
      ]
    },
    {
      label: "视图",
      items: [
        { label: ctx.showSide ? "隐藏对象导航" : "显示对象导航", action: () => ctx.setShowSide(value => !value) },
        { label: ctx.showInfo ? "隐藏对象信息" : "显示对象信息", action: () => ctx.setShowInfo(value => !value) },
        { separator: true },
        { label: "浅色主题", action: () => ctx.setTheme("light") },
        { label: "深色主题", action: () => ctx.setTheme("dark") },
        { label: "跟随系统", action: () => ctx.setTheme("system") }
      ]
    },
    {
      label: "数据库",
      items: [
        { label: "断开连接", disabled: !ctx.session, action: () => void ctx.disconnect() },
        { separator: true },
        {
          label: "表列表",
          disabled: !ctx.session || (!ctx.activeNode && ctx.roots.length === 0),
          action: () => ctx.session && void ctx.openTableList(ctx.activeNode ?? ctx.roots[0])
        },
        { label: "新建表…", disabled: !ctx.session, action: () => void ctx.createTableDraft() },
        { label: "脚本列表", disabled: !ctx.session, action: () => void ctx.openScriptList() },
        { label: "刷新对象", disabled: !ctx.session, action: () => void ctx.refreshObjectList(ctx.activeNode ?? ctx.roots[0]) }
      ]
    },
    {
      label: "查询",
      items: [
        { label: "新建查询", action: ctx.createQueryTab },
        { label: "新建脚本…", disabled: !ctx.session, action: () => void ctx.createScript() },
        { separator: true },
        { label: "执行", accelerator: ACCEL.run, disabled: ctx.activeTab?.kind !== "query", action: () => void ctx.runSelectionOrAll() },
        { label: "停止", disabled: !ctx.activeTab?.running, action: () => void ctx.stopQuery() },
        { label: "执行计划", disabled: ctx.activeTab?.kind !== "query", action: () => void ctx.explainActiveQuery() }
      ]
    },
    {
      label: "工具",
      items: [
        { label: "连接管理…", action: () => ctx.setManagerOpen(true) },
        { label: "新建连接", icon: "plus", children: newConnectionMenuEntries(ctx) },
        { separator: true },
        { label: "选项…", accelerator: ACCEL.options, action: () => ctx.setOptionsOpen(true) }
      ]
    },
    {
      label: "帮助",
      items: [
        {
          label: "关于 Valkyrie",
          action: () => ctx.setMessageBox({
            title: "关于 Valkyrie",
            message: "Valkyrie 数据库客户端\nElectron 界面 + Java 数据层\n版本 0.1.0"
          })
        }
      ]
    }
  ];
}
