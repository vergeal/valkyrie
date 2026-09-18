import { useEffect, useState } from "react";
import { invoke, messageOf, type QueryColumn, type QueryResultPayload } from "../api";
import type { WorkTab } from "../app/appTypes";
import type { MenuEntry } from "../ui/Menu";
import {
  gridSelectionToTsv,
  resolveDirtyRows,
  rowToJson,
  selectionCols,
  selectionRows,
  sqlLiteral,
  visibleRowIndices,
  type GridSelection
} from "./resultHelpers";

interface ResultAction {
  label: string;
  disabled: boolean;
  run: () => void;
}

interface UseResultGridOptions {
  currentResult: QueryResultPayload | null;
  activeTab: WorkTab | null;
  activeTabId: string;
  updateTab: (id: string, patch: Partial<WorkTab>) => void;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
  withBusy: <T>(action: () => Promise<T>) => Promise<T>;
  setPending: (value: string | null) => void;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  flash: (text: string) => void;
  exportResult: (format: "csv" | "excel") => void;
}

/**
 * 结果集域：网格选区 / 搜索 / 命中数、结果表动作（复制、编辑、提交、回滚、刷新、
 * 复制为 SQL/JSON）、右键菜单。结果集动作只在这里定义一份，工具条与右键菜单同源。
 */
export function useResultGrid(options: UseResultGridOptions) {
  const {
    currentResult, activeTab, activeTabId, updateTab, askConfirm, copyText,
    withBusy, setPending, setError, setStatus, flash, exportResult
  } = options;

  const [gridSelection, setGridSelection] = useState<GridSelection | null>(null);
  /* 结果集全表搜索：输入值 / 防抖后的关键字（同 FX 版，停顿一下再过滤） */
  const [gridSearch, setGridSearch] = useState("");
  const [gridKeyword, setGridKeyword] = useState("");
  /* 全局替换：替换成的文本（配合搜索关键字在可见行里批量替换） */
  const [gridReplace, setGridReplace] = useState("");
  /* 替换行默认收起，点搜索框里的展开按钮才出现 */
  const [gridReplaceOpen, setGridReplaceOpen] = useState(false);
  /* 命中行数（null = 未搜索），显示在结果集工具条上 */
  const [gridHits, setGridHits] = useState<number | null>(null);
  /* 刷新反馈：不弹提示，改成表格闪一下（计数变化即触发动画） */
  const [gridFlash, setGridFlash] = useState(0);

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
    setGridReplace("");
    setGridReplaceOpen(false);
  }, [activeTabId]);

  /*
   * 复制结果表选区为「制表符分隔」（Excel / WPS / 云表格直接粘）。
   * 转义规则见 resultHelpers.gridSelectionToTsv。
   */
  async function copyGridSelection() {
    if (!gridSelection || !currentResult?.rows)
      return;

    await copyText(gridSelectionToTsv(gridSelection, currentResult));
  }

  /** 本次未提交的改动条数（下拉 / 提示文案共用） */
  function pendingChangeCount(): number {
    return activeTab && "pending" in activeTab ? activeTab.pending ?? 0 : 0;
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
      const replaced = typeof payload.replaced === "number" ? payload.replaced : 0;
      const delta = method === "result.update" || method === "result.insert"
        ? 1
        : method === "result.delete" || method === "result.setNull"
          ? rowParams
          : method === "result.replace"
            ? replaced
            : 0;
      const clearsPending = method === "result.commit" || method === "result.rollback" || method === "result.reload";

      updateTab(tabId, {
        result: { ...payload, offset, size },
        /* 记录哪些行有未提交修改，用于行高亮（一处都没替换到就不动标记） */
        dirtyRows: method === "result.replace" && replaced === 0
          ? activeTab.dirtyRows
          : resolveDirtyRows(method, params, activeTab.dirtyRows),
        pending: clearsPending ? 0 : pendingBefore + delta
      });

      /* 提交时把改动条数报出来；替换时把实际改动的单元格数报出来 */
      const message = method === "result.commit"
        ? `已提交 ${pendingBefore} 条修改`
        : method === "result.replace"
          ? `已替换 ${replaced} 处（未提交）`
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

  /** 批量设为 NULL：改的是成片单元格，先问一句 */
  async function setSelectionNull() {
    if (!gridSelection)
      return;

    const rows = selectionRows(gridSelection);
    const cols = selectionCols(gridSelection);
    const confirmed = await askConfirm(
      `确定把选中的 ${rows.length} 行 × ${cols.length} 列设为 NULL？\n\n`
      + "提交后才会写入数据库，中途可以「回滚」。",
      "设为 NULL",
      true
    );

    if (confirmed)
      await runResultAction("result.setNull", { rows, cols }, "已设置为 NULL");
  }

  /**
   * 全局替换：在搜索结果命中的行里，把包含关键字的单元格批量替换成「替换为」的文本。
   * 只记进待提交缓冲，点「提交修改」才写库，中途可以「回滚」。
   */
  async function replaceGridValues() {
    if (!currentResult?.editable)
      return;

    const keyword = gridKeyword.trim();
    const rows = currentResult.rows ?? [];

    if (!keyword || rows.length === 0)
      return;

    const targets = visibleRowIndices(rows, keyword);

    if (targets.length === 0) {
      setStatus("没有可替换的匹配数据");
      return;
    }

    await runResultAction("result.replace", { rows: targets, find: keyword, replace: gridReplace });
  }

  /**
   * 提交修改：这一步才真正写库（尤其待删除的行会真的从表里消失），必须确认。
   */
  async function commitResultChanges() {
    if (!currentResult?.dirty)
      return;

    const pending = pendingChangeCount();
    const deleting = currentResult.deletedRows?.length ?? 0;
    const details = [
      deleting > 0 ? `· 删除 ${deleting} 行（提交后会真的从表里删掉，无法撤销）` : "",
      pending - deleting > 0 ? `· 修改 / 新增 ${pending - deleting} 处` : ""
    ].filter(Boolean).join("\n");

    const confirmed = await askConfirm(
      `确定把这次的改动写入数据库？\n\n${details || `· 共 ${pending} 处改动`}\n\n`
      + "写入后无法再「回滚」，请确认目标库（生产库尤其注意）。",
      "提交修改",
      true
    );

    if (confirmed)
      await runResultAction("result.commit", {}, "修改已提交");
  }

  /** 回滚：丢掉这次所有未提交改动（不弹确认，直接还原） */
  async function rollbackResultChanges() {
    if (!currentResult?.dirty)
      return;

    await runResultAction("result.rollback", {}, "已回滚未提交的修改");
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

  /*
   * 结果表动作只在这里定义一份：顶部工具条与右键菜单都从这里取
   * （文案、可用状态、执行逻辑同源，避免两个入口两套行为）。
   */
  const resultActions: Record<string, ResultAction> = {
    copy: {
      label: "复制选中单元格",
      disabled: !gridSelection || !currentResult?.rows,
      run: () => void copyGridSelection()
    },
    commit: {
      label: "提交修改",
      disabled: !currentResult?.dirty,
      run: () => void commitResultChanges()
    },
    insert: {
      label: "新增行",
      disabled: !currentResult?.addable,
      run: () => void runResultAction("result.insert", {}, "已新增一行")
    },
    setNull: {
      label: "设为 NULL",
      disabled: !currentResult?.editable || !gridSelection,
      run: () => void setSelectionNull()
    },
    replace: {
      label: "全部替换",
      disabled: !currentResult?.editable || !searchingGrid || (gridHits ?? 0) === 0,
      run: () => void replaceGridValues()
    },
    remove: {
      label: "删除选中行",
      disabled: !currentResult?.editable || !gridSelection,
      run: () => void deleteSelectedRows()
    },
    rollback: {
      label: "回滚",
      disabled: !currentResult?.dirty,
      run: () => void rollbackResultChanges()
    },
    reload: {
      label: "刷新",
      disabled: false,
      run: () => void runResultAction("result.reload", {}, "已刷新")
    }
  };

  /* 结果表右键菜单（Radix ContextMenu 负责弹出/定位/关闭） */
  const gridMenuEntries: MenuEntry[] = [
    { label: resultActions.copy.label, icon: "copy", disabled: resultActions.copy.disabled, action: resultActions.copy.run },
    { separator: true },
    { label: resultActions.commit.label, disabled: resultActions.commit.disabled, action: resultActions.commit.run },
    { label: resultActions.insert.label, disabled: resultActions.insert.disabled, action: resultActions.insert.run },
    { label: resultActions.setNull.label, disabled: resultActions.setNull.disabled, action: resultActions.setNull.run },
    { label: resultActions.remove.label, danger: true, disabled: resultActions.remove.disabled, action: resultActions.remove.run },
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

  return {
    gridSelection, setGridSelection,
    gridSearch, setGridSearch,
    gridReplace, setGridReplace,
    gridReplaceOpen, setGridReplaceOpen,
    gridKeyword, setGridKeyword, gridHits, setGridHits,
    gridFlash, setGridFlash,
    searchingGrid,
    resultActions, gridMenuEntries,
    runResultAction, copyGridSelection
  };
}
