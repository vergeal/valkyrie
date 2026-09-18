import { useEffect, useMemo, useState } from "react";
import { writeClipboard, type TableColumn, type TableIndex } from "../api";
import { Icon } from "./icons";

/** 设计器里的一行字段：原样发回数据层，改过名的带 originalName 让后端认出原来那一行 */
export interface DesignColumn {
  name: string;
  originalName?: string;
  type: string;
  defaultValue?: string;
  comment?: string;
  notNull: boolean;
  primary: boolean;
  autoIncrement: boolean;
}

export interface DesignIndex {
  name: string;
  originalName?: string;
  columnsText?: string;
  type?: string;
  visible: boolean;
}

interface TableDesignProps {
  table: string;
  columns: TableColumn[];
  indexes: TableIndex[];
  ddl: string;
  loading: boolean;
  /** 保存结构改动（外层负责二次确认、下发与重新读取结构） */
  onSave?: (columns: DesignColumn[], indexes: DesignIndex[]) => void;
  /** 删除已有的字段 / 索引行前问一句（外层弹确认框；新增行不用问） */
  onConfirmRemove?: (names: string[], kind: "字段" | "索引") => Promise<boolean>;
  /** 重新读一次结构与 DDL */
  onReload?: () => void;
  /** 直接执行编辑后的 DDL（外层负责确认） */
  onApply?: (ddl: string) => void;
}

type ColumnRow = DesignColumn & { key: string };
type IndexRow = DesignIndex & { key: string };

type DesignTab = "columns" | "indexes" | "ddl";

const INDEX_TYPES = ["NORMAL", "UNIQUE", "FULLTEXT", "SPATIAL"];

let rowSequence = 1;

function toColumnRow(column: TableColumn, position: number): ColumnRow {
  return {
    key: `c${position}-${column.name}`,
    name: column.name,
    type: column.type ?? "",
    defaultValue: column.defaultValue ?? "",
    comment: column.comment ?? "",
    notNull: Boolean(column.notNull),
    primary: Boolean(column.primary),
    autoIncrement: Boolean(column.autoIncrement)
  };
}

function toIndexRow(index: TableIndex, position: number): IndexRow {
  return {
    key: `i${position}-${index.name}`,
    name: index.name,
    columnsText: index.columnsText ?? "",
    type: index.type ?? "NORMAL",
    visible: index.visible !== false
  };
}

/** 只保留要发给数据层的字段（key 是界面内部用的） */
function toPayload<T extends { key: string }>(row: T): Omit<T, "key"> {
  const { key, ...rest } = row;

  return rest;
}

/**
 * 逐字段浅比较两批行是否一致。
 * 以前用 JSON.stringify 对比，每次编辑都要把所有行序列化一遍；字段值都是原始类型，浅比较即可。
 */
function sameRows<T extends { key: string }>(current: T[], baseline: T[]): boolean {
  if (current.length !== baseline.length)
    return false;

  for (let index = 0; index < current.length; index++) {
    const left = toPayload(current[index]) as Record<string, unknown>;
    const right = toPayload(baseline[index]) as Record<string, unknown>;
    const keys = Object.keys(left);

    if (keys.length !== Object.keys(right).length)
      return false;

    for (const key of keys)
      if (left[key] !== right[key])
        return false;
  }

  return true;
}

export function TableDesign({ table, columns, indexes, ddl, loading, onSave, onConfirmRemove, onReload, onApply }: TableDesignProps) {
  const [active, setActive] = useState<DesignTab>("columns");
  const [columnRows, setColumnRows] = useState<ColumnRow[]>([]);
  const [indexRows, setIndexRows] = useState<IndexRow[]>([]);
  const [pickedColumns, setPickedColumns] = useState<string[]>([]);
  const [pickedIndexes, setPickedIndexes] = useState<string[]>([]);
  const [edited, setEdited] = useState(ddl);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState("");

  /* 重新读取结构 / 切换表时重建编辑态，避免把上一张表的改动带过来 */
  const baselineColumns = useMemo(() => columns.map(toColumnRow), [columns]);
  const baselineIndexes = useMemo(() => indexes.map(toIndexRow), [indexes]);

  useEffect(() => {
    setColumnRows(baselineColumns.map(row => ({ ...row })));
    setPickedColumns([]);
    setProblem("");
  }, [baselineColumns, table]);

  useEffect(() => {
    setIndexRows(baselineIndexes.map(row => ({ ...row })));
    setPickedIndexes([]);
  }, [baselineIndexes, table]);

  useEffect(() => setEdited(ddl), [ddl, table]);

  const dirty = useMemo(
    () => !sameRows(columnRows, baselineColumns) || !sameRows(indexRows, baselineIndexes),
    [columnRows, indexRows, baselineColumns, baselineIndexes]
  );

  const ddlChanged = edited.trim() !== ddl.trim();

  function patchColumn(key: string, patch: Partial<ColumnRow>) {
    setColumnRows(previous => previous.map(row => row.key === key ? { ...row, ...patch } : row));
  }

  function patchIndex(key: string, patch: Partial<IndexRow>) {
    setIndexRows(previous => previous.map(row => row.key === key ? { ...row, ...patch } : row));
  }

  function addColumn() {
    const row: ColumnRow = {
      key: `c-new-${rowSequence++}`,
      name: "",
      type: "",
      defaultValue: "",
      comment: "",
      notNull: false,
      primary: false,
      autoIncrement: false
    };

    setColumnRows(previous => [...previous, row]);
    setPickedColumns([row.key]);
    setActive("columns");
  }

  function addIndex() {
    const row: IndexRow = {
      key: `i-new-${rowSequence++}`,
      name: "",
      columnsText: "",
      type: "NORMAL",
      visible: true
    };

    setIndexRows(previous => [...previous, row]);
    setPickedIndexes([row.key]);
    setActive("indexes");
  }

  async function removePicked() {
    if (active === "columns") {
      const picked = columnRows.filter(row => pickedColumns.includes(row.key));
      /* 已经在库里的字段：删掉这行意味着保存后 DROP COLUMN，必须先问一句 */
      const existing = picked.filter(row => baselineColumns.some(baseline => baseline.key === row.key));

      if (existing.length > 0 && onConfirmRemove) {
        const confirmed = await onConfirmRemove(existing.map(row => row.name || "（未命名）"), "字段");

        if (!confirmed)
          return;
      }

      setColumnRows(previous => previous.filter(row => !pickedColumns.includes(row.key)));
      setPickedColumns([]);
      return;
    }

    if (active === "indexes") {
      const picked = indexRows.filter(row => pickedIndexes.includes(row.key));
      const existing = picked.filter(row => baselineIndexes.some(baseline => baseline.key === row.key));

      if (existing.length > 0 && onConfirmRemove) {
        const confirmed = await onConfirmRemove(existing.map(row => row.name || "（未命名）"), "索引");

        if (!confirmed)
          return;
      }

      setIndexRows(previous => previous.filter(row => !pickedIndexes.includes(row.key)));
      setPickedIndexes([]);
    }
  }

  /** 保存前先自己查一遍：字段名不能空、不能重名；索引同理 */
  function save() {
    const columnNames = columnRows.map(row => row.name.trim());

    if (columnNames.some(name => !name)) {
      setProblem("字段名不能为空");
      setActive("columns");
      return;
    }

    if (new Set(columnNames.map(name => name.toLowerCase())).size !== columnNames.length) {
      setProblem("字段名重复了");
      setActive("columns");
      return;
    }

    const indexNames = indexRows.map(row => row.name.trim()).filter(Boolean);

    if (indexRows.some(row => !row.name.trim())) {
      setProblem("索引名不能为空");
      setActive("indexes");
      return;
    }

    if (new Set(indexNames.map(name => name.toLowerCase())).size !== indexNames.length) {
      setProblem("索引名重复了");
      setActive("indexes");
      return;
    }

    setProblem("");
    onSave?.(
      columnRows.map(row => ({
        ...toPayload(row),
        name: row.name.trim(),
        type: row.type.trim(),
        defaultValue: row.defaultValue?.trim() ? row.defaultValue : undefined,
        comment: row.comment?.trim() ? row.comment : undefined
      })),
      indexRows.map(row => ({
        ...toPayload(row),
        name: row.name.trim(),
        columnsText: row.columnsText?.trim() ?? ""
      }))
    );
  }

  async function copyDdl() {
    await writeClipboard(edited);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  if (loading)
    return <div className="empty">正在读取表结构…</div>;

  return (
    <div className="design">
      <div className="design-toolbar">
        <div className="design-tabs" role="tablist" aria-label="表设计页签">
          <button
            type="button"
            role="tab"
            aria-selected={active === "columns"}
            className={`design-tab${active === "columns" ? " is-active" : ""}`}
            onClick={() => setActive("columns")}
          >
            表结构<span className="design-tab-count">{columnRows.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active === "indexes"}
            className={`design-tab${active === "indexes" ? " is-active" : ""}`}
            onClick={() => setActive("indexes")}
          >
            索引<span className="design-tab-count">{indexRows.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={active === "ddl"}
            className={`design-tab${active === "ddl" ? " is-active" : ""}`}
            onClick={() => setActive("ddl")}
          >
            DDL
          </button>
        </div>

        {problem && <span className="design-problem">{problem}</span>}
        {dirty && !problem && <span className="design-problem">有未保存的结构改动</span>}

        <span className="design-toolbar-push" aria-hidden="true" />

        {active !== "ddl" && (
          <>
            <button type="button" className="tbtn" onClick={active === "columns" ? addColumn : addIndex}>
              <Icon name="plus" />新增行
            </button>
            <button
              type="button"
              className="tbtn"
              disabled={(active === "columns" ? pickedColumns : pickedIndexes).length === 0}
              onClick={removePicked}
            >
              <Icon name="minus" />删除行
            </button>
            <span className="tbtn-sep" aria-hidden="true" />
          </>
        )}
        <button type="button" className="tbtn" onClick={() => onReload?.()}>
          <Icon name="refresh" />刷新
        </button>
        <button
          type="button"
          className="tbtn is-primary"
          disabled={!dirty || !onSave}
          onClick={save}
        >
          <Icon name="save" />保存
        </button>
      </div>

      {active === "columns" && (
        <div className="design-scroll">
          <table className="design-table">
            <thead>
              <tr>
                <th className="design-pick" aria-label="选择" />
                <th className="design-seq">#</th>
                <th>字段名</th>
                <th>类型</th>
                <th className="design-flag">允许空</th>
                <th>默认值</th>
                <th>注释</th>
                <th className="design-flag">主键</th>
                <th className="design-flag">自增</th>
              </tr>
            </thead>
            <tbody>
              {columnRows.map((row, position) => {
                const isNew = !baselineColumns.some(baseline => baseline.key === row.key);

                return (
                  <tr key={row.key} className={row.primary ? "is-primary" : undefined}>
                    <td className="design-pick">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${row.name || "新字段"}`}
                        checked={pickedColumns.includes(row.key)}
                        onChange={event => setPickedColumns(previous => event.target.checked
                          ? [...previous, row.key]
                          : previous.filter(key => key !== row.key))}
                      />
                    </td>
                    <td className="design-seq is-num">
                      {position + 1}
                      {isNew && <span className="design-new" title="新增的字段">新</span>}
                    </td>
                    <td>
                      <input
                        className="design-input mono"
                        value={row.name}
                        aria-label={`字段名 ${position + 1}`}
                        spellCheck={false}
                        onChange={event => patchColumn(row.key, {
                          name: event.target.value,
                          /* 改过名的记下原名，后端据此发 CHANGE 而不是新增 */
                          originalName: isNew
                            ? undefined
                            : (row.originalName ?? baselineColumns.find(baseline => baseline.key === row.key)?.name)
                        })}
                      />
                    </td>
                    <td>
                      <input
                        className="design-input mono"
                        value={row.type}
                        aria-label={`字段类型 ${position + 1}`}
                        spellCheck={false}
                        placeholder="INT / VARCHAR(64) …"
                        onChange={event => patchColumn(row.key, {
                          type: event.target.value,
                          originalName: isNew
                            ? undefined
                            : (row.originalName ?? baselineColumns.find(baseline => baseline.key === row.key)?.name)
                        })}
                      />
                    </td>
                    <td className="design-flag">
                      <input
                        type="checkbox"
                        aria-label={`${row.name || position + 1} 允许空`}
                        checked={!row.notNull}
                        onChange={event => patchColumn(row.key, { notNull: !event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        className="design-input mono"
                        value={row.defaultValue ?? ""}
                        aria-label={`${row.name || position + 1} 默认值`}
                        spellCheck={false}
                        placeholder="NULL"
                        onChange={event => patchColumn(row.key, { defaultValue: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="design-input"
                        value={row.comment ?? ""}
                        aria-label={`${row.name || position + 1} 注释`}
                        onChange={event => patchColumn(row.key, { comment: event.target.value })}
                      />
                    </td>
                    <td className="design-flag">
                      <input
                        type="checkbox"
                        aria-label={`${row.name || position + 1} 主键`}
                        checked={row.primary}
                        onChange={event => patchColumn(row.key, { primary: event.target.checked })}
                      />
                    </td>
                    <td className="design-flag">
                      <input
                        type="checkbox"
                        aria-label={`${row.name || position + 1} 自增`}
                        checked={row.autoIncrement}
                        onChange={event => patchColumn(row.key, { autoIncrement: event.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {active === "indexes" && (
        <div className="design-scroll">
          <table className="design-table">
            <thead>
              <tr>
                <th className="design-pick" aria-label="选择" />
                <th className="design-seq">#</th>
                <th>索引名</th>
                <th>字段</th>
                <th>类型</th>
                <th className="design-flag">可见</th>
              </tr>
            </thead>
            <tbody>
              {indexRows.map((row, position) => {
                const isNew = !baselineIndexes.some(baseline => baseline.key === row.key);

                return (
                  <tr key={row.key}>
                    <td className="design-pick">
                      <input
                        type="checkbox"
                        aria-label={`选择索引 ${row.name || position + 1}`}
                        checked={pickedIndexes.includes(row.key)}
                        onChange={event => setPickedIndexes(previous => event.target.checked
                          ? [...previous, row.key]
                          : previous.filter(key => key !== row.key))}
                      />
                    </td>
                    <td className="design-seq is-num">
                      {position + 1}
                      {isNew && <span className="design-new" title="新增的索引">新</span>}
                    </td>
                    <td>
                      <input
                        className="design-input mono"
                        value={row.name}
                        aria-label={`索引名 ${position + 1}`}
                        spellCheck={false}
                        onChange={event => patchIndex(row.key, {
                          name: event.target.value,
                          originalName: isNew
                            ? undefined
                            : (row.originalName ?? baselineIndexes.find(baseline => baseline.key === row.key)?.name)
                        })}
                      />
                    </td>
                    <td>
                      <input
                        className="design-input mono"
                        value={row.columnsText ?? ""}
                        aria-label={`索引字段 ${position + 1}`}
                        spellCheck={false}
                        placeholder="`col_a`, `col_b`"
                        onChange={event => patchIndex(row.key, { columnsText: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="design-input"
                        value={INDEX_TYPES.includes(row.type ?? "") ? row.type : "NORMAL"}
                        aria-label={`索引类型 ${position + 1}`}
                        onChange={event => patchIndex(row.key, { type: event.target.value })}
                      >
                        {INDEX_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                      </select>
                    </td>
                    <td className="design-flag">
                      <input
                        type="checkbox"
                        aria-label={`${row.name || position + 1} 可见`}
                        checked={row.visible}
                        onChange={event => patchIndex(row.key, { visible: event.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
              {indexRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="design-empty">没有索引，点「新增行」加一个</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {active === "ddl" && (
        <div className="ddl">
          <div className="ddl-title">
            <Icon name="code" />DDL · {table}
            <span className="ddl-actions">
              {ddlChanged && <span className="ddl-dirty">已修改</span>}
              <button type="button" className="mini-btn" onClick={() => void copyDdl()}>
                <Icon name="copy" size={12} />{copied ? "已复制" : "复制"}
              </button>
              <button type="button" className="mini-btn" disabled={!ddlChanged} onClick={() => setEdited(ddl)}>
                <Icon name="refresh" size={12} />还原
              </button>
              <button
                type="button"
                className="mini-btn is-danger"
                disabled={!ddlChanged || !onApply}
                onClick={() => onApply?.(edited)}
              >
                <Icon name="play" size={12} />执行 DDL
              </button>
            </span>
          </div>
          <textarea
            className="ddl-editor mono"
            value={edited || "-- 无 DDL"}
            spellCheck={false}
            aria-label={`${table} 的 DDL`}
            onChange={event => setEdited(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
