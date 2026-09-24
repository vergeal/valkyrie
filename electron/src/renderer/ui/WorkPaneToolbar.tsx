import type { QueryColumn, SavedConnection, SchemaNode, ScriptFile } from "../api";
import type { QueryTab, WorkTab } from "../app/appTypes";
import { KEY } from "../keys";
import { Select } from "./Select";
import { Icon } from "./icons";

/** 工作区标题下方的工作条：按当前标签类型显示不同操作与 SQL 执行上下文选择器。 */
export function WorkPaneToolbar(props: {
  tabsEmpty: boolean;
  locatableNode: SchemaNode | null;
  activeTab: WorkTab | null;
  sessionName: string | null;
  connections: SavedConnection[];
  catalogOptions: SchemaNode[];
  schemaOptions: SchemaNode[];
  tableNodes: SchemaNode[];
  rows: (string | null)[][];
  columns: QueryColumn[];
  pending: string | null;
  scriptSelections: ScriptFile[];
  objectSelections: SchemaNode[];
  scriptFilter: string;
  setScriptFilter: (value: string) => void;
  tableFilter: string;
  setTableFilter: (value: string) => void;
  onReveal: (node: SchemaNode) => void;
  onRunSelectionOrAll: () => void;
  onStopQuery: () => void;
  onFormatQuery: () => void;
  onExplainQuery: () => void;
  /** 当前编辑器（选区优先）是否为可分析的查询语句 */
  canExplain: boolean;
  onUpdateQueryPath: (patch: Partial<QueryTab["path"]>) => void;
  onOpenConnection: (connection: SavedConnection) => void;
  onOpenTableData: (node: SchemaNode) => void;
  onOpenTableDesign: (node: SchemaNode) => void;
  onCreateScript: () => void;
  onOpenScriptFile: (script: ScriptFile) => void;
  onRenameScriptFile: (script: ScriptFile) => void;
  onRevealPath: (path: string) => void;
  onDeleteScriptFiles: (files: ScriptFile[]) => void;
  onRefreshScriptList: (tabId: string) => void;
  onCreateTableDraft: (catalogHint?: string) => void;
  onRefreshTableList: (tabId: string, node: SchemaNode) => void;
  onLoadPage: (tabId: string, node: SchemaNode, page: number, pageSize: number) => Promise<void>;
  onGridFlash: () => void;
  onLoadDesign: (tabId: string, node: SchemaNode) => void;
}) {
  const {
    tabsEmpty, locatableNode, activeTab, sessionName, connections, catalogOptions, schemaOptions, tableNodes,
    rows, columns, pending, scriptSelections, objectSelections, scriptFilter, setScriptFilter, tableFilter, setTableFilter,
    onReveal, onRunSelectionOrAll, onStopQuery, onFormatQuery, onExplainQuery, canExplain, onUpdateQueryPath, onOpenConnection,
    onOpenTableData, onOpenTableDesign, onCreateScript, onOpenScriptFile, onRenameScriptFile, onRevealPath,
    onDeleteScriptFiles, onRefreshScriptList, onCreateTableDraft, onRefreshTableList, onLoadPage, onGridFlash, onLoadDesign
  } = props;

  return (
    <div className={`pane-toolbar${tabsEmpty ? " is-hidden" : ""}`}>
      {/* 当前标签在对象树里有对应节点时，给一个定位入口 */}
      {locatableNode && (
        <>
          <button
            type="button"
            className="tbtn"
            title={`在对象树中定位 ${locatableNode.label}`}
            onClick={() => onReveal(locatableNode)}
          >
            <Icon name="locate" />定位
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
        </>
      )}

      {activeTab?.kind === "query" && (
        <>
          {/* 连接 / 数据库 / 模式：SQL 执行上下文，放在「执行」前面 */}
          <span className="path-selector">
            <span className="path-item">
              <label htmlFor={`path-conn-${activeTab.id}`}>连接</label>
              <Select
                id={`path-conn-${activeTab.id}`}
                value={sessionName ?? ""}
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
                    onUpdateQueryPath({ connection: name, catalog: undefined, schema: undefined, table: undefined });
                    onOpenConnection(connection);
                  }
                }}
              />
            </span>

            <span className="path-item">
              <label htmlFor={`path-catalog-${activeTab.id}`}>数据库</label>
              <Select
                id={`path-catalog-${activeTab.id}`}
                icon="layers"
                /* 顶层是模式时（达梦）用它显示 / 切换模式 */
                value={activeTab.path.catalog ?? activeTab.path.schema ?? ""}
                disabled={catalogOptions.length === 0}
                options={catalogOptions.length === 0
                  ? [{ value: "", label: "—" }]
                  : catalogOptions.map(node => ({ value: node.label, label: node.label }))}
                onChange={name => {
                  const node = catalogOptions.find(item => item.label === name);

                  /* 顶层是模式（达梦）时写进 schema，别把模式名当库名 */
                  onUpdateQueryPath(node?.kind === "SCHEMA"
                    ? { catalog: undefined, schema: name, table: undefined }
                    : { catalog: name, schema: undefined, table: undefined });
                }}
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
                onChange={schema => onUpdateQueryPath({ schema: schema || undefined, table: undefined })}
              />
            </span>
          </span>

          <span className="tbtn-sep" aria-hidden="true" />

          <button
            type="button"
            /* 执行中只置灰，不加转圈 / 闪烁动画（进度看状态栏与日志页） */
            className="tbtn is-primary"
            disabled={activeTab.running}
            title={`执行 (${KEY.run})`}
            onClick={onRunSelectionOrAll}
          >
            <Icon name="play" />执行
          </button>
          <button
            type="button"
            className="tbtn is-danger"
            disabled={!activeTab.running}
            onClick={onStopQuery}
          >
            <Icon name="stop" />停止
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button type="button" className="tbtn" onClick={onFormatQuery}>
            <Icon name="code" />格式化
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={!canExplain || activeTab.running}
            title="执行计划（查询语句）"
            onClick={onExplainQuery}
          >
            <Icon name="zap" />执行计划
          </button>
          <span className="toolbar-text">
            {activeTab.running ? "执行中…" : `${activeTab.sql.split("\n").length} 行`}
          </span>

          {/* 表：位置保持不变 */}
          <span className="path-selector">
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
                  onUpdateQueryPath({ table: table || undefined });

                  /* 选表即打开数据页，和 Navicat 里双击表一致 */
                  const node = tableNodes.find(item => item.label === table);
                  if (node) onOpenTableData(node);
                }}
              />
            </span>
          </span>
        </>
      )}

      {activeTab?.kind === "objects" && activeTab.view === "scripts" && (
        <>
          <button type="button" className="tbtn" onClick={onCreateScript}>
            <Icon name="plus" />新建脚本
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={scriptSelections.length === 0}
            onClick={() => scriptSelections.forEach(script => onOpenScriptFile(script))}
          >
            <Icon name="terminal" />打开
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={scriptSelections.length !== 1}
            onClick={() => scriptSelections[0] && onRenameScriptFile(scriptSelections[0])}
          >
            <Icon name="pencil" />重命名
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={scriptSelections.length !== 1}
            onClick={() => scriptSelections[0] && onRevealPath(scriptSelections[0].path)}
          >
            <Icon name="folderOpen" />在文件夹中显示
          </button>
          <button
            type="button"
            className="tbtn is-danger"
            disabled={scriptSelections.length === 0}
            onClick={() => onDeleteScriptFiles(scriptSelections)}
          >
            <Icon name="trash" />删除
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button
            type="button"
            className={`tbtn${activeTab.loading ? " is-busy" : ""}`}
            disabled={activeTab.loading}
            onClick={() => onRefreshScriptList(activeTab.id)}
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
            onClick={() => onCreateTableDraft(activeTab.node.catalog ?? activeTab.node.label)}
          >
            <Icon name="plus" />新建表
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={objectSelections.length === 0}
            onClick={() => objectSelections.forEach(node => onOpenTableData(node))}
          >
            <Icon name="table" />打开表
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={objectSelections.length === 0}
            onClick={() => objectSelections.forEach(node => onOpenTableDesign(node))}
          >
            <Icon name="columns" />设计表
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button
            type="button"
            className={`tbtn${pending === "tableList" ? " is-busy" : ""}`}
            disabled={pending === "tableList"}
            onClick={() => onRefreshTableList(activeTab.id, activeTab.node)}
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
            onClick={() => void onLoadPage(activeTab.id, activeTab.node, activeTab.page, activeTab.pageSize).then(onGridFlash)}
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
            onClick={() => onLoadPage(activeTab.id, activeTab.node, activeTab.page - 1, activeTab.pageSize)}
          >
            上一页
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={rows.length < activeTab.pageSize}
            onClick={() => onLoadPage(activeTab.id, activeTab.node, activeTab.page + 1, activeTab.pageSize)}
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
          <button type="button" className="tbtn" onClick={() => onLoadDesign(activeTab.id, activeTab.node)}>
            <Icon name="refresh" />重新读取
          </button>
        </>
      )}
    </div>
  );
}
