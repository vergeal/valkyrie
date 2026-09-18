import type { QueryColumn, QueryResultPayload } from "../api";

export interface GridSelection {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** 选区里真正可见的行 / 列下标（搜索过滤时排除被隐藏的行） */
  rowList: number[];
  colList: number[];
}

/*
 * 选区 → 行 / 列下标。优先用网格上报的「可见行」列表：搜索过滤时被隐藏的行
 * 不参与删除 / 置空，避免误伤看不见的数据。
 */
export const selectionRows = (selection: GridSelection) =>
  selection.rowList?.length
    ? selection.rowList
    : Array.from({ length: selection.r2 - selection.r1 + 1 }, (_, index) => selection.r1 + index);

export const selectionCols = (selection: GridSelection) =>
  selection.colList?.length
    ? selection.colList
    : Array.from({ length: selection.c2 - selection.c1 + 1 }, (_, index) => selection.c1 + index);

/**
 * 全表搜索的行匹配：忽略大小写、纯子串（与 ResultGrid 内的过滤规则同源）。
 * keyword 传进来前会 trim + 小写。
 */
export function rowMatchesKeyword(row: (string | null)[], keyword: string): boolean {
  if (!keyword)
    return true;

  return row.some(cell => cell !== null && String(cell).toLowerCase().includes(keyword));
}

/** 全表搜索命中的行下标（关键字为空时视为全部可见） */
export function visibleRowIndices(rows: (string | null)[][], keyword: string): number[] {
  const lower = keyword.trim().toLowerCase();

  if (!lower)
    return rows.map((_, index) => index);

  const indices: number[] = [];

  rows.forEach((row, index) => {
    if (rowMatchesKeyword(row, lower))
      indices.push(index);
  });

  return indices;
}

/**
 * 复制结果表选区为「制表符分隔」（Excel / WPS / 云表格直接粘）。
 *
 * 格子里出现制表符 / 换行 / 双引号时按 Excel 的惯例用双引号包起来（内部引号翻倍），
 * 否则粘到 Excel 会被拆成多格；NULL 按空格子处理。
 */
export function gridSelectionToTsv(selection: GridSelection, result: QueryResultPayload): string {
  const rows = selectionRows(selection);
  const cols = selectionCols(selection);

  const cell = (rowIndex: number, colIndex: number) => {
    const value = result.rows?.[rowIndex]?.[colIndex];
    const text = value == null ? "" : String(value);

    return /["\t\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return rows
    .map(rowIndex => cols.map(colIndex => cell(rowIndex, colIndex)).join("\t"))
    .join("\r\n");
}

/** SQL 字面量：NULL 原样，其余单引号转义后包起来 */
export function sqlLiteral(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

export function rowToJson(columns: QueryColumn[], row: (string | null)[]): Record<string, string | null> {
  const json: Record<string, string | null> = {};

  columns.forEach((column, index) => {
    json[column.name || column.label] = row[index] ?? null;
  });

  return json;
}

/**
 * 维护"有未提交修改"的行号：编辑单元格时累加，提交/回滚/刷新/删除后清空。
 */
export function resolveDirtyRows(method: string, params: Record<string, unknown>, current: number[]): number[] {
  if (method === "result.update") {
    const row = Number(params.row);
    return current.includes(row) ? current : [...current, row];
  }

  if (method === "result.setNull") {
    const rows = Array.isArray(params.rows) ? params.rows.map(Number) : [];
    return [...new Set([...current, ...rows])];
  }

  if (method === "result.replace") {
    const rows = Array.isArray(params.rows) ? params.rows.map(Number) : [];
    return [...new Set([...current, ...rows])];
  }

  return [];
}
