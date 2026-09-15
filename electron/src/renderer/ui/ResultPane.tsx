import type { QueryColumn, QueryResultPayload, SchemaNode, ScriptFile } from "../api";
import type { ResultPane as ResultPaneKind, WorkTab } from "../app/appTypes";
import type { GridSelection } from "../result/resultHelpers";
import type { AppSettings } from "../settings";
import { ResultGrid } from "./ResultGrid";
import { TableList } from "./TableList";
import { ScriptList } from "./ScriptList";
import { TableDesign, type DesignColumn, type DesignIndex } from "./TableDesign";
import { LogConsole, type LogRecord } from "./LogConsole";
import { Icon } from "./icons";

type ResultAction = { label: string; disabled: boolean; run: () => void };

/** 结果区：结果集 / 消息 / 执行计划 / 日志，以及对象页（表列表 / 脚本列表）。 */
export function ResultPane(props: {
  tabsEmpty: boolean;
  pageTab: boolean;
  resultPane: ResultPaneKind;
  setResultPane: (pane: ResultPaneKind) => void;
  activeTab: WorkTab | null;
  rows: (string | null)[][];
  columns: QueryColumn[];
  lastCost: number | null;
  currentResult: QueryResultPayload | null;
  pending: string | null;
  settings: AppSettings;
  resultActions: Record<string, ResultAction>;
  gridSearch: string;
  setGridSearch: (value: string) => void;
  searchingGrid: boolean;
  gridHits: number | null;
  gridKeyword: string;
  gridFlash: number;
  setGridHits: (value: number | null) => void;
  setGridSelection: (value: GridSelection | null) => void;
  onCellCommit: (row: number, col: number, value: string | null) => void;
  onExport: (format: "csv" | "excel") => void;
  onExplain: () => void;
  onGridContextMenu: () => void;
  tableFilter: string;
  listFlash: number;
  tableSelection: string[];
  setTableSelection: (names: string[]) => void;
  setActiveNode: (node: SchemaNode | null) => void;
  onOpenTable: (node: SchemaNode) => void;
  onTableContextMenu: (node: SchemaNode) => void;
  scriptFilter: string;
  scriptFlash: number;
  scriptSelection: string[];
  setScriptSelection: (paths: string[]) => void;
  onOpenScript: (script: ScriptFile) => void;
  onScriptContextMenu: (script: ScriptFile) => void;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
  onSaveDesign: (columns: DesignColumn[], indexes: DesignIndex[]) => void;
  onReloadDesign: () => void;
  onApplyDdl: (ddl: string) => void;
  logs: LogRecord[];
  setLogs: (records: LogRecord[]) => void;
  copyText: (text: string) => void;
}) {
  const {
    tabsEmpty, pageTab, resultPane, setResultPane, activeTab, rows, columns, lastCost,
    currentResult, pending, settings, resultActions,
    gridSearch, setGridSearch, searchingGrid, gridHits, gridKeyword, gridFlash,
    setGridHits, setGridSelection, onCellCommit, onExport, onExplain, onGridContextMenu,
    tableFilter, listFlash, tableSelection, setTableSelection, setActiveNode, onOpenTable, onTableContextMenu,
    scriptFilter, scriptFlash, scriptSelection, setScriptSelection, onOpenScript, onScriptContextMenu,
    askConfirm, onSaveDesign, onReloadDesign, onApplyDdl, logs, setLogs, copyText
  } = props;

  return (
    <div className={`result${tabsEmpty ? " is-hidden" : ""}`}>
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
          <button type="button" className={`result-tab${resultPane === "plan" ? " is-active" : ""}`} onClick={onExplain}>
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
            disabled={resultActions.insert.disabled}
            onClick={resultActions.insert.run}
          >
            <Icon name="plus" />{resultActions.insert.label}
          </button>
          <button
            type="button"
            className={`tbtn is-danger${pending === "result.delete" ? " is-busy" : ""}`}
            disabled={resultActions.remove.disabled}
            onClick={resultActions.remove.run}
          >
            <Icon name="trash" />{resultActions.remove.label}
          </button>
          <button
            type="button"
            className={`tbtn${pending === "result.setNull" ? " is-busy" : ""}`}
            disabled={resultActions.setNull.disabled}
            onClick={resultActions.setNull.run}
          >
            {resultActions.setNull.label}
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button
            type="button"
            className={`tbtn is-primary${pending === "result.commit" ? " is-busy" : ""}`}
            disabled={resultActions.commit.disabled}
            onClick={resultActions.commit.run}
          >
            <Icon name="check" />{resultActions.commit.label}
          </button>
          <button
            type="button"
            className={`tbtn${pending === "result.rollback" ? " is-busy" : ""}`}
            disabled={resultActions.rollback.disabled}
            onClick={resultActions.rollback.run}
          >
            <Icon name="refresh" />{resultActions.rollback.label}
          </button>
          <span className="tbtn-sep" aria-hidden="true" />
          <button
            type="button"
            className={`tbtn${pending === "result.reload" ? " is-busy" : ""}`}
            onClick={resultActions.reload.run}
          >
            <Icon name="refresh" />{resultActions.reload.label}
          </button>
          <button type="button" className="tbtn" onClick={() => onExport("csv")}>
            <Icon name="csv" />导出 CSV
          </button>
          <button type="button" className="tbtn" onClick={() => onExport("excel")}>
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
              onOpen={onOpenTable}
              onContextMenu={node => onTableContextMenu(node)}
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
              onOpen={script => onOpenScript(script)}
              onContextMenu={script => onScriptContextMenu(script)}
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
            onSave={(cols, indexes) => onSaveDesign(cols, indexes)}
            onConfirmRemove={(names, kind) => askConfirm(
              `确定从设计里删掉${kind} ${names.join("、")}？\n\n`
              + `这一步只是改设计稿（点「刷新」可还原）；`
              + `点「保存」后才会真正从数据库里删掉${kind === "字段" ? "，字段里的数据会一起丢失" : "，索引会一起丢失"}。`,
              `删除${kind}`,
              true
            )}
            onReload={onReloadDesign}
            onApply={onApplyDdl}
          />
        )}

        {resultPane === "grid" && !pageTab && activeTab?.kind !== "design" && (
          <div className="grid-host">
            <ResultGrid
              columns={columns}
              rows={rows}
              flashToken={gridFlash}
              fontSize={settings.gridFontSize}
              showTypes={settings.gridHeaderType}
              onContextMenu={onGridContextMenu}
              offset={activeTab?.kind === "data" ? activeTab.result?.offset ?? 0 : 0}
              editable={Boolean(currentResult?.editable)}
              dirtyRows={activeTab && "dirtyRows" in activeTab ? activeTab.dirtyRows : []}
              deletedRows={currentResult?.deletedRows ?? []}
              search={gridKeyword}
              onSearchHitsChange={setGridHits}
              onCellCommit={onCellCommit}
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
            onCopy={text => copyText(text)}
          />
        )}
      </div>
    </div>
  );
}
