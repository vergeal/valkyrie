import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SchemaNode } from "../api";
import { Icon } from "./icons";

type SortKey = "name" | "rows" | "size" | "engine" | "comment" | "createTime" | "updateTime";
type SortDirection = "asc" | "desc";

interface TableListProps {
  tables: SchemaNode[];
  loading: boolean;
  filter: string;
  /** 计数变化即让列表闪一下（刷新反馈） */
  flashToken?: number;
  /** 当前选中的行（按表名匹配，支持多选） */
  selectedNames: string[];
  onSelectionChange: (names: string[]) => void;
  onOpen: (node: SchemaNode) => void;
  /** 右键某行（外层据此弹出系统原生菜单） */
  onContextMenu: (node: SchemaNode) => void;
}

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "名称" },
  { key: "rows", label: "行", className: "is-num" },
  { key: "size", label: "数据长度", className: "is-num" },
  { key: "engine", label: "引擎" },
  { key: "comment", label: "注释" },
  { key: "updateTime", label: "修改日期" },
  { key: "createTime", label: "创建日期" }
];

function formatSize(size?: number): string {
  if (size == null)
    return "-";

  if (size < 1024)
    return `${size.toFixed(1)} KB`;

  return `${(size / 1024).toFixed(1)} MB`;
}

function formatTime(value?: number): string {
  if (!value)
    return "-";

  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sortValue(node: SchemaNode, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return node.label.toLowerCase();
    case "rows":
      return node.table?.rows ?? null;
    case "size":
      return node.table?.size ?? null;
    case "engine":
      return node.table?.engine?.toLowerCase() ?? null;
    case "comment":
      return node.table?.comment?.toLowerCase() ?? null;
    case "createTime":
      return node.table?.createTime ?? null;
    default:
      return node.table?.updateTime ?? null;
  }
}

/**
 * 表列表总览（参考 Navicat）：名称 / 行数 / 大小 / 引擎 / 注释 / 时间，
 * 表头可排序、支持按名称与注释过滤，双击打开数据、右键走对象菜单。
 */
export function TableList(props: TableListProps) {
  const { tables, loading, filter, selectedNames, onSelectionChange, onOpen, onContextMenu, flashToken = 0 } = props;
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const [refreshing, setRefreshing] = useState(false);
  /* Shift 连选时的锚点（按当前可见顺序的下标） */
  const anchor = useRef<number | null>(null);
  /* 挂载时的初始计数：首屏（首次加载）本来就没有旧内容可换，不该闪 */
  const initialFlash = useRef(flashToken);
  /* 上一次闪烁的结束时刻：短时间内的连续信号合并成一次，避免连闪 */
  const flashUntil = useRef(0);

  useEffect(() => {
    if (flashToken === initialFlash.current || Date.now() < flashUntil.current)
      return;

    flashUntil.current = Date.now() + 140;
    setRefreshing(true);
    const timer = window.setTimeout(() => setRefreshing(false), 140);
    return () => window.clearTimeout(timer);
  }, [flashToken]);

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase();

    const matched = keyword
      ? tables.filter(node =>
          node.label.toLowerCase().includes(keyword)
          || (node.table?.comment ?? "").toLowerCase().includes(keyword))
      : tables;

    const factor = sort.direction === "asc" ? 1 : -1;

    return [...matched].sort((a, b) => {
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);

      /* 空值统一排在最后 */
      if (left == null && right == null)
        return a.label.localeCompare(b.label);

      if (left == null)
        return 1;

      if (right == null)
        return -1;

      if (typeof left === "number" && typeof right === "number")
        return (left - right) * factor;

      return String(left).localeCompare(String(right)) * factor;
    });
  }, [tables, filter, sort]);

  function toggleSort(key: SortKey) {
    setSort(previous => previous.key === key
      ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  }

  /**
   * 行选择：单击替换选中；Ctrl/Cmd+单击增减单行；Shift+单击从锚点连选一段。
   */
  function selectRow(event: ReactMouseEvent, index: number) {
    const name = visible[index]?.label;

    if (!name)
      return;

    const additive = event.ctrlKey || event.metaKey;

    if (event.shiftKey && anchor.current != null) {
      const from = Math.min(anchor.current, index);
      const to = Math.max(anchor.current, index);
      const range = visible.slice(from, to + 1).map(node => node.label);

      onSelectionChange(additive ? Array.from(new Set([...selectedNames, ...range])) : range);
      return;
    }

    anchor.current = index;

    if (additive) {
      onSelectionChange(selectedNames.includes(name)
        ? selectedNames.filter(item => item !== name)
        : [...selectedNames, name]);
      return;
    }

    onSelectionChange([name]);
  }

  if (loading)
    return <div className="empty">正在读取表列表…</div>;

  if (tables.length === 0)
    return <div className="empty">当前模式下没有数据表</div>;

  return (
    <div className="table-list-wrap">
      <table className={`table-list${refreshing ? " is-refreshing" : ""}`}>
        <thead>
          <tr>
            {COLUMNS.map(column => (
              <th
                key={column.key}
                className={`is-sortable${column.className ? ` ${column.className}` : ""}${sort.key === column.key ? " is-sorted" : ""}`}
                onClick={() => toggleSort(column.key)}
                title={`按${column.label}排序`}
              >
                {column.label}
                <span className="sort-mark">{sort.key === column.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
              </th>
            ))}
            {/* 占位列：吃掉剩余宽度，数据列因此保持按内容的固定宽度 */}
            <th className="table-filler" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {visible.map((node, index) => (
            <tr
              key={node.id}
              className={selectedNames.includes(node.label) ? "is-active" : undefined}
              onClick={event => selectRow(event, index)}
              onDoubleClick={() => onOpen(node)}
              onContextMenu={event => {
                event.preventDefault();

                if (!selectedNames.includes(node.label))
                  onSelectionChange([node.label]);

                onContextMenu(node);
              }}
            >
              <td className="table-name">
                <Icon name="table" size={13} />
                <span className="table-name-text">{node.label}</span>
              </td>
              <td className="is-num">{node.table?.rows != null ? node.table.rows.toLocaleString() : "-"}</td>
              <td className="is-num">{formatSize(node.table?.size)}</td>
              <td>{node.table?.engine || "-"}</td>
              <td className="table-comment" title={node.table?.comment ?? ""}>{node.table?.comment || "-"}</td>
              {/* 顺序与 COLUMNS 一致：修改日期在创建日期之前 */}
              <td className="is-time">{formatTime(node.table?.updateTime)}</td>
              <td className="is-time">{formatTime(node.table?.createTime)}</td>
              <td className="table-filler" />
            </tr>
          ))}
        </tbody>
      </table>

      {visible.length === 0 && <div className="empty">没有匹配「{filter}」的表</div>}
    </div>
  );
}
