import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ScriptFile } from "../api";
import { formatByteSize } from "../app/format";
import { Icon } from "./icons";

type SortKey = "name" | "catalog" | "size" | "modified";
type SortDirection = "asc" | "desc";

interface ScriptListProps {
  scripts: ScriptFile[];
  loading: boolean;
  filter: string;
  /** 计数变化即让列表闪一下（刷新反馈） */
  flashToken?: number;
  selectedPaths: string[];
  onSelectionChange: (paths: string[]) => void;
  onOpen: (script: ScriptFile) => void;
  onContextMenu: (script: ScriptFile) => void;
}

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "名称" },
  { key: "catalog", label: "数据库" },
  { key: "size", label: "大小", className: "is-num" },
  { key: "modified", label: "修改日期", className: "is-time" }
];

function formatTime(value?: number): string {
  if (!value)
    return "-";

  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sortValue(script: ScriptFile, key: SortKey): string | number {
  switch (key) {
    case "catalog":
      return script.catalog.toLowerCase();
    case "size":
      return script.size;
    case "modified":
      return script.modified;
    default:
      return script.name.toLowerCase();
  }
}

/**
 * 脚本对象页：列出当前连接下所有数据库目录里的 .sql 脚本，
 * 支持排序、过滤、多选、双击打开、右键菜单（与「对象」页一致的操作方式）。
 */
export function ScriptList(props: ScriptListProps) {
  const { scripts, loading, filter, flashToken = 0, selectedPaths, onSelectionChange, onOpen, onContextMenu } = props;
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const [refreshing, setRefreshing] = useState(false);
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
      ? scripts.filter(script =>
          script.name.toLowerCase().includes(keyword) || script.catalog.toLowerCase().includes(keyword))
      : scripts;
    const factor = sort.direction === "asc" ? 1 : -1;

    return [...matched].sort((a, b) => {
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);

      if (typeof left === "number" && typeof right === "number")
        return (left - right) * factor;

      return String(left).localeCompare(String(right), "zh-CN") * factor;
    });
  }, [scripts, filter, sort]);

  function toggleSort(key: SortKey) {
    setSort(previous => previous.key === key
      ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  }

  /** 单击替换选中；Ctrl/Cmd 增减；Shift 从锚点连选 */
  function selectRow(event: ReactMouseEvent, index: number) {
    const path = visible[index]?.path;

    if (!path)
      return;

    const additive = event.ctrlKey || event.metaKey;

    if (event.shiftKey && anchor.current != null) {
      const from = Math.min(anchor.current, index);
      const to = Math.max(anchor.current, index);
      const range = visible.slice(from, to + 1).map(script => script.path);

      onSelectionChange(additive ? Array.from(new Set([...selectedPaths, ...range])) : range);
      return;
    }

    anchor.current = index;

    if (additive) {
      onSelectionChange(selectedPaths.includes(path)
        ? selectedPaths.filter(item => item !== path)
        : [...selectedPaths, path]);
      return;
    }

    onSelectionChange([path]);
  }

  if (loading)
    return <div className="empty">正在读取脚本列表…</div>;

  if (scripts.length === 0)
    return <div className="empty">还没有脚本，点「新建脚本」创建第一个 .sql 文件</div>;

  return (
    <div className="table-list-wrap">
      <table className={`table-list script-list${refreshing ? " is-refreshing" : ""}`}>
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
            <th className="table-filler" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {visible.map((script, index) => (
            <tr
              key={script.path}
              className={selectedPaths.includes(script.path) ? "is-active" : undefined}
              onClick={event => selectRow(event, index)}
              onDoubleClick={() => onOpen(script)}
              onContextMenu={event => {
                event.preventDefault();

                if (!selectedPaths.includes(script.path))
                  onSelectionChange([script.path]);

                onContextMenu(script);
              }}
            >
              <td className="table-name">
                <Icon name="terminal" size={13} />
                <span className="table-name-text">{script.name}</span>
              </td>
              <td>
                <span className="script-catalog">
                  <Icon name="database" size={12} />
                  {script.catalog || "-"}
                </span>
              </td>
              <td className="is-num">{formatByteSize(script.size)}</td>
              <td className="is-time">{formatTime(script.modified)}</td>
              <td className="table-filler" />
            </tr>
          ))}
        </tbody>
      </table>

      {visible.length === 0 && <div className="empty">没有匹配「{filter}」的脚本</div>}
    </div>
  );
}
