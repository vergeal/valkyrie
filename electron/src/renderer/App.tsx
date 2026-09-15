import { useEffect, useMemo, useRef, useState } from "react";
import {
  revealPath,
  type SchemaNode
} from "./api";
import type { ResultPane, SessionState, WorkTab } from "./app/appTypes";
import { NEXT_THEME, THEME_ICON, THEME_LABEL } from "./app/appConstants";
import { useAppSettings } from "./app/useAppSettings";
import { useAppTheme } from "./app/useAppTheme";
import { useAppLifecycle } from "./app/useAppLifecycle";
import { useDialogs } from "./dialogs/useDialogs";
import { useExport } from "./export/useExport";
import { useResultGrid } from "./result/useResultGrid";
import { useQueryExecution } from "./query/useQueryExecution";
import { useEditorShortcutRefs, useQueryShortcuts } from "./query/useQueryShortcuts";
import { useMonacoEditor } from "./editor/useMonacoEditor";
import { useTabs } from "./tabs/useTabs";
import { useConnectionSessions, type ConnectionTabsApi } from "./connection/useConnectionSessions";
import { useSchemaTree } from "./schema/useSchemaTree";
import { useSchemaActions } from "./schema/useSchemaActions";
import { useQueryContext } from "./query/useQueryContext";
import { useObjectPage } from "./objects/useObjectPage";
import {
  sessionByName as sessionByNameHelper,
  sessionOfTab as sessionOfTabHelper
} from "./connection/connectionHelpers";
import {
  moveTabInList,
  tabIconName,
  tabKindLabel,
  treeNodeOfTab
} from "./tabs/tabHelpers";
import { type TableContext } from "./table/tableActions";
import { useTableData } from "./table/useTableData";
import { useTableDesign } from "./table/useTableDesign";
import { useTableActions } from "./table/useTableActions";
import { copyTextToClipboard } from "./result/resultClipboard";
import {
  buildAppMenus,
  buildContextMenu,
  buildEditorMenuEntries,
  buildObjectMenu,
  buildScriptMenuEntries,
  buildTabMenuEntries,
  newConnectionMenuEntries,
  type MenuContext
} from "./menus/contextMenus";
import { useAppMenu } from "./menus/useAppMenu";
import { AppTitlebar } from "./ui/AppTitlebar";
import { AppMenuBar } from "./ui/AppMenuBar";
import { AppStatusBar } from "./ui/AppStatusBar";
import { InfoPanel } from "./ui/InfoPanel";
import { AppDialogs } from "./ui/AppDialogs";
import { AppToolbar } from "./ui/AppToolbar";
import { SidePanel } from "./ui/SidePanel";
import { WorkTabs } from "./ui/WorkTabs";
import { ResultPane as ResultPaneView } from "./ui/ResultPane";
import { WorkPaneToolbar } from "./ui/WorkPaneToolbar";
import { popupNativeMenu } from "./ui/Menu";
import { IS_MAC } from "./keys";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";

export function App() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["conn-root"]));
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(new Set());
  const [activeNode, setActiveNode] = useState<SchemaNode | null>(null);

  const [resultPane, setResultPane] = useState<ResultPane>("grid");
  const [treeFilter, setTreeFilter] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSide, setShowSide] = useState(true);
  const [showInfo, setShowInfo] = useState(true);

  /* 客户端配置 / 主题 / Dialog / App 生命周期状态集中在各自 Hook 里 */
  const { settings, updateSettings } = useAppSettings();
  const { theme, setTheme, themeResolved } = useAppTheme(settings, updateSettings);
  const {
    status, setStatus, maximized, error, setError, busy, pending, setPending, flash, withBusy
  } = useAppLifecycle();
  const {
    confirmDialog, setConfirmDialog, askConfirm, answerConfirm,
    textDialog, setTextDialog, askText, answerText,
    messageBox, setMessageBox,
    connectionDialog, setConnectionDialog,
    managerOpen, setManagerOpen,
    optionsOpen, setOptionsOpen
  } = useDialogs();

  /*
   * 每个连接上次在「对象」页看的位置（表列表 / 脚本列表）。
   * 多连接并存时「对象」页只有一页，切连接要把它交还给新连接：
   * 有记忆就回到原来那批对象，没记忆就退回该连接的第一个库。
   */
  const objectTargetRef = useRef<Record<string, { view: "tables" | "scripts"; node: SchemaNode | null }>>({});
  /*
   * 「对象」页全局只有一页。showTableList / showScriptList 都是先 await 读库再落标签，
   * 并发触发时各自都看不到对方刚要建的标签，于是会各开一页；这里用 ref 先占住唯一 id，
   * 让并发调用最终都写到同一个标签上。
   */
  const objectTabIdRef = useRef<string | null>(null);
  /* Tab 域的动作在所有 Hook 建好后回填，供 connection 域在关闭连接时使用 */
  const tabsApiRef = useRef<ConnectionTabsApi | null>(null);
  /* Schema 域动作回填：早期 Hook 通过它取树查找 / 会话解析 */
  const treeApiRef = useRef<ReturnType<typeof useSchemaTree> | null>(null);
  /* 对象页动作回填：connection / schema 在对象页 Hook 建好前通过它取对象页动作 */
  const objectApiRef = useRef<ReturnType<typeof useObjectPage> | null>(null);
  /* 执行上下文动作回填：connection 在关闭连接时清空数据库候选 */
  const queryContextApiRef = useRef<ReturnType<typeof useQueryContext> | null>(null);

  /* 连接 / 会话域：连接列表 / 活动会话 / 根节点缓存 + 连接生命周期 */
  const connection = useConnectionSessions({
    tabsRef: tabsApiRef,
    focusObjectPage: (name, context) => objectApiRef.current?.focusObjectPage(name, context),
    objectTargetRef,
    setExpanded,
    setLoadingNodes,
    setActiveNode,
    setCatalogOptions: nodes => queryContextApiRef.current?.setCatalogOptions(nodes),
    clearUiOnDisconnect,
    askConfirm,
    setConnectionDialog,
    withBusy,
    setPending,
    setError,
    setStatus,
    flash
  });
  const {
    connections, session, setSession, sessionRef, lastSessionRef,
    openSessions, rootsByConnection, roots, setRoots, openingConnections,
    refreshConnections, openConnection, disconnect,
    openAllConnections, closeAllConnections, refreshConnectionRoots, deleteConnection, onConnectionSaved
  } = connection;

  /* Tab 域：标签状态 / 拖拽 / 溢出 + 新建、关闭命令 */
  const tabsApi = useTabs({
    connections,
    session,
    openConnection,
    getSelectionContext: () => queryContextApiRef.current?.selectionContext() ?? { catalog: undefined },
    askConfirm,
    setResultPane
  });
  tabsApiRef.current = tabsApi;
  const {
    tabs, setTabs, activeTabId, setActiveTabId, activeTab,
    tabDrag, setTabDrag, tabsOverflow, tabsRef,
    updateTab, createQueryTab, openQueryTab, closeTabs, closeTab, updateQueryPath
  } = tabsApi;

  /* Schema 域：对象树缓存 / 载入 / 展开 / 刷新，以及结构信息（列 / 索引） */
  const schema = useSchemaTree({
    expanded, setExpanded, loadingNodes, setLoadingNodes, activeNode,
    session, openSessions, connections, rootsByConnection,
    tabs, setTabs, activeTabId, setActiveTabId,
    openConnection, refreshConnectionRoots,
    showTableList: (node, options) => objectApiRef.current?.showTableList(node, options) ?? Promise.resolve(),
    refreshTableList: (tabId, container) => objectApiRef.current?.refreshTableList(tabId, container) ?? Promise.resolve(),
    setError, setStatus, flash
  });
  treeApiRef.current = schema;
  const {
    treeRoot, treeChildren, loadChildren, toggleNode, closeTabsUnder, loadTableNodes,
    firstTableContainer, refreshObjectList,
    infoColumns, setInfoColumns, infoIndexes, setInfoIndexes
  } = schema;

  /* 早期 Hook / 后续逻辑通过 treeApiRef 取树的查找与会话解析 */
  function connectionOfNode(node: SchemaNode | null | undefined): string | undefined {
    return treeApiRef.current?.connectionOfNode(node);
  }

  function sessionOfNode(node: SchemaNode | null | undefined, tab?: WorkTab | null): SessionState | null {
    return treeApiRef.current?.sessionOfNode(node, tab) ?? null;
  }

  function parentTreeNode(id: string): SchemaNode | null {
    return treeApiRef.current?.parentTreeNode(id) ?? null;
  }

  /* 执行上下文域：数据库 / 模式 / 表候选 + SQL 补全上下文 */
  const queryContext = useQueryContext({
    session, connections, roots, tabs, setTabs, activeTab, activeNode,
    loadChildren, treeRoot, treeChildren, lastSessionRef
  });
  queryContextApiRef.current = queryContext;
  const {
    catalogOptions, setCatalogOptions,
    schemaOptions, setSchemaOptions, tableNodes, setTableNodes,
    suggestionContextRef
  } = queryContext;

  /* 对象页 + 脚本域：「对象」标签（表列表 / 脚本列表）与脚本生命周期 */
  const objects = useObjectPage({
    session, openSessions, sessionRef, activeNode, catalogOptions, roots, rootsByConnection,
    tabs, setTabs, updateTab, setActiveTabId, activeTab,
    sessionOfNode, connectionOfNode, sessionByName,
    loadTableNodes, firstTableContainer, parentTreeNode, loadChildren, treeChildren,
    askText, askConfirm, setError, setStatus, setPending,
    objectTargetRef, objectTabIdRef
  });
  objectApiRef.current = objects;
  const {
    tableSelection, setTableSelection, tableFilter, setTableFilter, listFlash,
    scriptFilter, setScriptFilter, scriptSelection, setScriptSelection, scriptFlash,
    objectSelections, scriptSelections,
    showTableList, openTableList, focusObjectPage, refreshTableList,
    openScriptFile, openScript, scriptCatalog, createScript, renameScriptFile, renameScript,
    deleteScriptFiles, deleteScript, showScriptList,
    openScriptList, refreshScriptList, saveActiveScript
  } = objects;

  /* 关闭连接后清空工作区相关状态（对象页 / 网格 / 信息面板 / 日志等） */
  function clearUiOnDisconnect() {
    setResultPane("grid");
    setSchemaOptions([]);
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
    setLastCost(null);
    setError(null);
  }



  /* 表数据 / 表设计域：打开数据页 / 设计页、分页与结构读写、对象表操作 */
  const tableContext: TableContext = {
    settings, tabs, setTabs, setActiveTabId, updateTab, sessionOfNode, connectionOfNode,
    askConfirm, withBusy, setPending, setError, setStatus, flash, refreshObjectList,
    activeNode, session, copyText, setTableSelection
  };
  const { openTableData, loadPage, executeStatement, clearTable, dropTable, dropTables } = useTableData(tableContext);
  const { openTableDesign, loadDesign, saveTableDesign, applyTableDdl, copyDdl } = useTableDesign(tableContext);

  /* 表独立动作：新建表草稿 */
  const { createTableDraft } = useTableActions({
    session, connections, askText, openQueryTab, updateTab, scriptCatalog, setError, setStatus
  });

  /* 对象树交互：选中 / 双击 / 定位 / 刷新 */
  const { revealTreeNode, selectTreeNode, activateNode, refreshNode } = useSchemaActions({
    setActiveNode, setExpanded, openSessions, session, setSession, rootsByConnection,
    setRoots, setCatalogOptions, setSchemaOptions, setTableNodes,
    connectionOfNode, sessionOfNode, parentTreeNode, loadChildren, toggleNode,
    focusObjectPage, showScriptList, showTableList, openScript, openScriptList, openTableList,
    openTableData, openTableDesign, refreshConnectionRoots, refreshConnections, withBusy,
    setError, setStatus, flash
  });

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


  const editorContainer = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef(activeTabId);

  activeTabRef.current = activeTabId;

  /* ------------------------------ 初始化 ------------------------------ */

  useEffect(() => {
    void refreshConnections();
  }, []);




  /** 连接名 → 会话：多连接并存时按名字取，取不到退回当前活动会话 */
  function sessionByName(name?: string): SessionState | null {
    return sessionByNameHelper(name, openSessions, session);
  }


  /** 标签对应的会话（控制台执行、取消、执行计划都按标签所属连接取） */
  function sessionOfTab(tab: WorkTab | null | undefined): SessionState | null {
    return sessionOfTabHelper(tab, openSessions, session);
  }

  /** 选中节点 → 执行上下文：连接名 + 数据库 + 模式 */



  /* ------------------------------ 对象操作 ------------------------------ */

  function copyText(text: string) {
    return copyTextToClipboard(text, { onStatus: setStatus, onError: setError });
  }






  const { runShortcutRef, formatShortcutRef, saveShortcutRef } = useEditorShortcutRefs();

  /*
   * Monaco 编辑器的生命周期集中在这里：创建 / 选项 / 主题 / 内容与当前标签同步 /
   * 补全 Provider / 快捷键命令 / 缩进空白标记。命令通过上面几个 ref 取「当前」处理函数。
   */
  const { editorRef } = useMonacoEditor({
    settings,
    containerRef: editorContainer,
    suggestionContextRef,
    runShortcutRef,
    formatShortcutRef,
    saveShortcutRef,
    activeTab,
    editorPanelRef,
    onContentChange: value => {
      const tabId = activeTabRef.current;

      setTabs(previous => previous.map(tab =>
        tab.id === tabId && tab.kind === "query" ? { ...tab, sql: value } : tab));
    }
  });

  /* 查询执行域：执行 / 取消 / 执行计划 / 格式化 / progress 日志 */
  const {
    stopQuery, formatActiveQuery, explainActiveQuery, runSelectionOrAll, logs, setLogs, lastCost, setLastCost
  } = useQueryExecution({
    tabs, updateTab, setTabs, activeTab, editorRef,
    resolveSessionByName: name => sessionByName(name),
    resolveSessionOfTab: tab => sessionOfTab(tab),
    setError, setStatus, setResultPane,
    logLimit: settings.logLimit
  });


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

  /* 导出生命周期（结果集 CSV / Excel、单表与整库 .sql、进度事件） */
  const { exportProgress, exportResult, exportTableSql, exportDatabaseSql, exportPercent } = useExport({
    resultJobId: currentResult?.jobId,
    resolveSession: node => sessionOfNode(node),
    onError: setError,
    onStatus: setStatus
  });

  /* 结果集域：选区 / 搜索 / 结果表动作 / 右键菜单 */
  const {
    gridSelection, setGridSelection,
    gridSearch, setGridSearch,
    gridKeyword, setGridKeyword, gridHits, setGridHits,
    gridFlash, setGridFlash,
    searchingGrid,
    resultActions, gridMenuEntries,
    runResultAction, copyGridSelection
  } = useResultGrid({
    currentResult,
    activeTab,
    activeTabId,
    updateTab,
    askConfirm,
    copyText,
    withBusy,
    setPending,
    setError,
    setStatus,
    flash,
    exportResult
  });

  /* 快捷键域：窗口级快捷键与 macOS 菜单转发的 ⌘A / ⌘C */
  const { selectAllInPage, gridCopyRef } = useQueryShortcuts({
    runShortcutRef, formatShortcutRef, saveShortcutRef,
    runSelectionOrAll, formatActiveQuery, saveActiveScript,
    activeTab, editorRef, gridSelection, currentResult, copyGridSelection,
    setTableSelection, setScriptSelection, setStatus, setOptionsOpen
  });

  /* 对象列是整页列表：结果集那一套面板（消息 / 执行计划 / 日志）在这里不出现 */
  const pageTab = activeTab?.kind === "objects";




  const currentConnection = connections.find(item => item.name === session?.name) ?? null;

  /* 菜单构建需要的状态与动作：集中组装成 MenuContext，交给 menus 模块构建菜单 */
  const menuContext: MenuContext = {
    expanded, openSessions, openingConnections, connections, session, activeNode, roots, treeChildren, tabs, activeTab,
    objectSelections, scriptSelections, tableSelection, scriptSelection,
    showSide, showInfo, currentConnection, editorRef, gridCopyRef,
    setShowSide, setShowInfo, setTheme, setConnectionDialog, setManagerOpen, setOptionsOpen, setMessageBox,
    createQueryTab, openAllConnections, closeAllConnections, refreshConnections,
    disconnect, deleteConnection, toggleNode, refreshNode, refreshObjectList, openTableList,
    createTableDraft, exportTableSql, exportDatabaseSql, openTableData, openTableDesign,
    copyDdl, clearTable, dropTable, dropTables,
    openScript, renameScript, deleteScript, openScriptList, createScript, openScriptFile,
    deleteScriptFiles, renameScriptFile, saveActiveScript,
    runSelectionOrAll, formatActiveQuery, stopQuery, explainActiveQuery, selectAllInPage,
    copyText, revealPath, closeTabs, revealTreeNode
  };
  const menus = buildAppMenus(menuContext);
  useAppMenu(menus);

  /* 当前标签在对象树里对应的节点（有才给「定位」按钮） */
  const locatableNode = treeNodeOfTab(activeTab, treeChildren);

  return (
    <div className={`app${settings.gridZebra ? "" : " no-zebra"}${settings.gridRowNumbers ? "" : " no-rownum"}${IS_MAC ? " is-mac" : ""}${themeResolved === "dark" ? " is-dark" : " is-light"}`}>
      <AppTitlebar
        sessionName={session?.name ?? null}
        currentDatabase={currentDatabase}
        maximized={maximized}
      />

      {!IS_MAC && (
        <AppMenuBar
          menus={menus}
          openMenu={openMenu}
          onOpenChange={(open, label) => setOpenMenu(open ? label : null)}
          status={status}
        />
      )}

      <AppToolbar
        canOpenTableList={Boolean(session && (activeNode || roots.length > 0))}
        pageSize={activeTab && activeTab.kind === "data" ? activeTab.pageSize : settings.pageSize}
        themeLabel={THEME_LABEL[theme]}
        themeIcon={THEME_ICON[theme]}
        onNewConnection={() => void popupNativeMenu(newConnectionMenuEntries(menuContext))}
        onNewQuery={createQueryTab}
        onOpenTableList={() => session && void openTableList(activeNode ?? roots[0])}
        onOpenScriptList={() => void openScriptList()}
        onCycleTheme={() => setTheme(NEXT_THEME[theme])}
      />

      <Group
        orientation="horizontal"
        id="valkyrie-columns"
        defaultLayout={columnsLayout.defaultLayout}
        onLayoutChanged={columnsLayout.onLayoutChanged}
        className={`work-body${showSide ? "" : " no-side"}${showInfo ? "" : " no-info"}`}
      >
        <Panel id="side" className="side-panel" defaultSize="23%" minSize="13%" maxSize="36%">
          <SidePanel
            treeRoot={treeRoot}
            treeChildren={treeChildren}
            expanded={expanded}
            loadingNodes={loadingNodes}
            activeNodeId={activeNode?.id ?? null}
            treeFilter={treeFilter}
            refreshingConnections={pending === "connections"}
            onTreeFilterChange={setTreeFilter}
            onRefreshConnections={() => void refreshConnections()}
            onToggle={node => void toggleNode(node)}
            onSelect={selectTreeNode}
            onActivate={activateNode}
            onOpenData={openTableData}
            onDesign={openTableDesign}
            onCopyName={node => void navigator.clipboard?.writeText(node.label)}
            menuFor={node => buildContextMenu(node, menuContext)}
          />
        </Panel>

        <Separator className="splitter splitter-v splitter-side" aria-label="调整对象树宽度" />

        <Panel id="work" className="work-panel" minSize="30%">
        <main className="work-main">
          <WorkTabs
            tabs={tabs}
            activeTabId={activeTabId}
            tabDrag={tabDrag}
            tabsOverflow={tabsOverflow}
            tabsRef={tabsRef}
            setTabDrag={setTabDrag}
            onSelectTab={setActiveTabId}
            onCloseTab={closeTab}
            onMoveTab={(from, to, after) => setTabs(previous => moveTabInList(previous, from, to, after))}
            onTabContextMenu={id => void popupNativeMenu(buildTabMenuEntries(id, menuContext))}
            onCreateQuery={createQueryTab}
            onRefreshConnections={() => void refreshConnections()}
            onShowAllTabs={() => void popupNativeMenu(tabs.map(tab => ({
              label: tab.id === activeTabId ? `● ${tab.title}` : tab.title,
              icon: tabIconName(tab),
              action: () => setActiveTabId(tab.id)
            })))}
          />

          <WorkPaneToolbar
            tabsEmpty={tabs.length === 0}
            locatableNode={locatableNode}
            activeTab={activeTab}
            sessionName={session?.name ?? null}
            connections={connections}
            catalogOptions={catalogOptions}
            schemaOptions={schemaOptions}
            tableNodes={tableNodes}
            rows={rows}
            columns={columns}
            pending={pending}
            scriptSelections={scriptSelections}
            objectSelections={objectSelections}
            scriptFilter={scriptFilter}
            setScriptFilter={setScriptFilter}
            tableFilter={tableFilter}
            setTableFilter={setTableFilter}
            onReveal={revealTreeNode}
            onRunSelectionOrAll={() => void runSelectionOrAll()}
            onStopQuery={() => void stopQuery()}
            onFormatQuery={() => void formatActiveQuery()}
            onUpdateQueryPath={updateQueryPath}
            onOpenConnection={connection => void openConnection(connection)}
            onOpenTableData={openTableData}
            onOpenTableDesign={openTableDesign}
            onCreateScript={() => void createScript()}
            onOpenScriptFile={script => void openScriptFile(script)}
            onRenameScriptFile={script => void renameScriptFile(script)}
            onRevealPath={path => void revealPath(path)}
            onDeleteScriptFiles={files => void deleteScriptFiles(files)}
            onRefreshScriptList={tabId => void refreshScriptList(tabId)}
            onCreateTableDraft={catalogHint => void createTableDraft(catalogHint)}
            onRefreshTableList={(tabId, node) => void refreshTableList(tabId, node)}
            onLoadPage={loadPage}
            onGridFlash={() => setGridFlash(previous => previous + 1)}
            onLoadDesign={(tabId, node) => void loadDesign(tabId, node)}
          />

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

                    void popupNativeMenu(buildEditorMenuEntries(hasSelection, menuContext));
                  }}
                />
              </div>
            </Panel>

            {activeTab?.kind === "query" && <Separator className="splitter splitter-h" aria-label="调整编辑器高度" />}

            <Panel id="result" className="result-panel" defaultSize="20%" minSize="12%">
              <ResultPaneView
                tabsEmpty={tabs.length === 0}
                pageTab={pageTab}
                resultPane={resultPane}
                setResultPane={setResultPane}
                activeTab={activeTab}
                rows={rows}
                columns={columns}
                lastCost={lastCost}
                currentResult={currentResult}
                pending={pending}
                settings={settings}
                resultActions={resultActions}
                gridSearch={gridSearch}
                setGridSearch={setGridSearch}
                searchingGrid={searchingGrid}
                gridHits={gridHits}
                gridKeyword={gridKeyword}
                gridFlash={gridFlash}
                setGridHits={setGridHits}
                setGridSelection={setGridSelection}
                onCellCommit={(row, col, value) => void runResultAction("result.update", { row, col, value }, "已修改（未提交）")}
                onExport={format => void exportResult(format)}
                onExplain={() => void explainActiveQuery()}
                onGridContextMenu={() => void popupNativeMenu(gridMenuEntries)}
                tableFilter={tableFilter}
                listFlash={listFlash}
                tableSelection={tableSelection}
                setTableSelection={setTableSelection}
                setActiveNode={setActiveNode}
                onOpenTable={openTableData}
                onTableContextMenu={node => void popupNativeMenu(buildObjectMenu(node, menuContext))}
                scriptFilter={scriptFilter}
                scriptFlash={scriptFlash}
                scriptSelection={scriptSelection}
                setScriptSelection={setScriptSelection}
                onOpenScript={script => void openScriptFile(script)}
                onScriptContextMenu={script => void popupNativeMenu(buildScriptMenuEntries(script, menuContext))}
                askConfirm={askConfirm}
                onSaveDesign={(cols, indexes) => activeTab?.kind === "design" && void saveTableDesign(activeTab.id, activeTab.node, cols, indexes)}
                onReloadDesign={() => activeTab?.kind === "design" && void loadDesign(activeTab.id, activeTab.node)}
                onApplyDdl={ddl => activeTab?.kind === "design" && void applyTableDdl(activeTab.id, activeTab.node, ddl)}
                logs={logs}
                setLogs={setLogs}
                copyText={copyText}
              />
            </Panel>
          </Group>
        </main>
        </Panel>

        <Separator className="splitter splitter-v splitter-info" aria-label="调整对象信息宽度" />

        <Panel id="info" className="info-panel" defaultSize="19%" minSize="12%" maxSize="30%">
          <InfoPanel
            node={activeNode}
            connectionName={session?.name ?? null}
            product={session?.product ?? null}
            columns={infoColumns}
            indexes={infoIndexes}
            onOpenData={openTableData}
            onDesign={openTableDesign}
          />
        </Panel>
      </Group>

      <AppStatusBar
        sessionName={session?.name ?? null}
        productLabel={productLabel}
        currentDatabase={currentDatabase}
        tabKind={tabKindLabel(activeTab?.kind)}
        rows={rows.length}
        lastCost={lastCost}
        status={status}
        busy={busy}
      />

      <AppDialogs
        confirmDialog={confirmDialog}
        answerConfirm={answerConfirm}
        connectionDialog={connectionDialog}
        setConnectionDialog={setConnectionDialog}
        onConnectionSaved={onConnectionSaved}
        managerOpen={managerOpen}
        setManagerOpen={setManagerOpen}
        connections={connections}
        connectedName={session?.name ?? null}
        onManagerOpen={connection => {
          setManagerOpen(false);
          void openConnection(connection);
        }}
        onManagerEdit={(mode, connection) => setConnectionDialog({ mode, connection: connection ?? null })}
        onManagerDelete={connection => void deleteConnection(connection.name)}
        onManagerRefresh={() => void refreshConnections()}
        optionsOpen={optionsOpen}
        setOptionsOpen={setOptionsOpen}
        settings={settings}
        theme={theme}
        updateSettings={updateSettings}
        setTheme={setTheme}
        exportProgress={exportProgress}
        exportPercent={exportPercent}
        messageBox={messageBox}
        setMessageBox={setMessageBox}
        textDialog={textDialog}
        answerText={answerText}
      />
    </div>
  );
}

