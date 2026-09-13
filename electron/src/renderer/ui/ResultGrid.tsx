import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { isNumericType, type QueryColumn } from "../api";
import { KEY } from "../keys";
import { Icon } from "./icons";

interface CellRef {
  row: number;
  col: number;
}

interface ResultGridProps {
  columns: QueryColumn[];
  rows: (string | null)[][];
  /** 计数变化即让表格闪一下（刷新反馈） */
  flashToken?: number;
  /** 表格字号（px）：列宽按这个字号实测 */
  fontSize?: number;
  /** 右键单元格（外层据此弹出系统原生菜单） */
  onContextMenu?: () => void;
  offset?: number;
  editable?: boolean;
  dirtyRows?: number[];
  /** 全表搜索关键字：过滤显示行，并把命中的文字用黄色标出来 */
  search?: string;
  /** 命中行数变化（null = 未搜索），外层工具条据此显示“命中 N 行” */
  onSearchHitsChange?: (hits: number | null) => void;
  onCellCommit?: (row: number, col: number, value: string | null) => void;
  onSelectionChange?: (selection: {
    r1: number; r2: number; c1: number; c2: number;
    row: number; col: number; rows: number; cols: number;
    /** 选区里真正可见（未被搜索过滤掉）的行 / 列下标 */
    rowList: number[]; colList: number[];
  } | null) => void;
}

/* 与 styles.css 里 table.grid 的字号保持一致，列宽才是按真实文字量算的 */
/* 与 styles.css 里 table.grid 的字体保持一致（等宽），列宽才量得准 */
const GRID_FONT = '14px Consolas, "Cascadia Mono", "Courier New", monospace';
const CELL_PADDING = 20;
const MIN_COLUMN_WIDTH = 64;
/* 列宽上限收窄：超长内容改为换行显示，而不是把列撑得很宽 */
const MAX_COLUMN_WIDTH = 320;
const MEASURE_ROWS = 200;
const MEASURE_CHARS = 60;

let measureContext: CanvasRenderingContext2D | null = null;

/**
 * 命中高亮：按纯子串、忽略大小写把文本切段，命中片段套 `mark`（黄底深字）。
 * 逻辑对齐 FX 版 SearchHighlight.flow，只是这里返回的是 React 节点。
 */
function highlight(text: string, keyword: string): ReactNode {
  if (!keyword)
    return text;

  const lower = text.toLowerCase();

  if (!lower.includes(keyword))
    return text;

  const nodes: ReactNode[] = [];
  let from = 0;
  let index = lower.indexOf(keyword);

  while (index >= 0) {
    if (index > from)
      nodes.push(text.slice(from, index));

    nodes.push(
      <mark key={index} className="grid-hit">{text.slice(index, index + keyword.length)}</mark>
    );

    from = index + keyword.length;
    index = lower.indexOf(keyword, from);
  }

  if (from < text.length)
    nodes.push(text.slice(from));

  return nodes;
}

/**
 * 按当前数据算列宽：表头（字段名 / 类型两行）与单元格内容（最多前 200 行、
 * 每格截断 60 字符）取最大文字宽度，再夹到 72~420px。
 */
function measureColumns(columns: QueryColumn[], rows: (string | null)[][], fontSize: number): Record<number, number> {
  if (typeof document === "undefined")
    return {};

  measureContext ??= document.createElement("canvas").getContext("2d");

  if (!measureContext)
    return {};

  measureContext.font = GRID_FONT.replace(/^\d+px/, `${fontSize}px`);

  const widths: Record<number, number> = {};
  const sample = rows.slice(0, MEASURE_ROWS);
  const textWidth = (text: string) => measureContext!.measureText(text).width;

  columns.forEach((column, index) => {
    /* 表头是两行：字段名 + 类型（主键还有小图标） */
    let width = Math.max(
      textWidth(column.label),
      textWidth(`${column.type ?? ""}${column.notNull ? " · NOT NULL" : ""}`)
    );

    if (column.primary)
      width += 18;

    for (const row of sample) {
      const value = row[index];
      const text = value === null || value === undefined ? "NULL" : String(value).slice(0, MEASURE_CHARS);
      width = Math.max(width, textWidth(text));
    }

    widths[index] = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width + CELL_PADDING)));
  });

  return widths;
}

export function ResultGrid(props: ResultGridProps) {
  const {
    columns, rows, flashToken = 0, fontSize = 14, offset = 0, editable = false, dirtyRows = [],
    search = "", onSearchHitsChange, onCellCommit, onSelectionChange, onContextMenu
  } = props;
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [focus, setFocus] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<CellRef | null>(null);
  const [draft, setDraft] = useState("");
  /* 多行文本走气泡里的多行编辑器（单行仍在单元格内联编辑） */
  const [bubbleEdit, setBubbleEdit] = useState(false);
  /* 尺寸只在打开时算一次：之后用户可以自由缩放，滚动重定位不覆盖它 */
  const [bubbleSize, setBubbleSize] = useState<{ width: number; height: number } | null>(null);
  const [bubblePos, setBubblePos] = useState<{
    top: number; left: number; arrow: number; placement: "below" | "above";
  } | null>(null);
  /* 选区模式：整行（从行号列拖）/ 矩形（从数据单元格拖） */
  const [rowMode, setRowMode] = useState(false);
  /* 整列（从列头拖） */
  const [colMode, setColMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /* 刷新反馈：内容先清空一瞬再重新出现（不弹提示） */
  useEffect(() => {
    if (!flashToken)
      return;

    setRefreshing(true);
    const timer = window.setTimeout(() => setRefreshing(false), 140);
    return () => window.clearTimeout(timer);
  }, [flashToken]);
  /* 手动拖过的列宽优先；其余按当前数据实测 */
  const [manualWidths, setManualWidths] = useState<Record<number, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<number, number>>({});
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragging = useRef(false);
  /* 防止 blur 与主动提交重复触发 */
  const committing = useRef(false);
  /* 刚拖过列宽时忽略随后的 click，避免误触发"选中整列" */
  const lastResizeAt = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing)
      return;

    if (bubbleEdit) {
      const area = textareaRef.current;

      area?.focus();
      /* 光标落到末尾：接着往下写不用先点一下 */
      area?.setSelectionRange(area.value.length, area.value.length);
      return;
    }

    inputRef.current?.focus();
  }, [editing, bubbleEdit]);

  /*
   * 气泡定位：贴着正在编辑的单元格浮出 —— 下方放得下就放下方，放不下翻到上方，
   * 左右再夹到窗口内，并按单元格中心算三角箭头的水平位置。
   * 表格内部滚动、窗口缩放、气泡被手动缩放时都重新贴一次。
   */
  useLayoutEffect(() => {
    if (!bubbleEdit || !editing) {
      setBubblePos(null);
      return;
    }

    const place = () => {
      const anchor = wrapRef.current?.querySelector("td.is-editing")?.getBoundingClientRect();
      const box = bubbleRef.current?.getBoundingClientRect();

      if (!anchor || !box)
        return;

      const height = box.height;
      const spaceBelow = window.innerHeight - anchor.bottom;
      const placement = spaceBelow >= height + 14 ? "below" : "above";
      const top = placement === "below"
        ? anchor.bottom + 8
        : Math.max(8, anchor.top - height - 8);
      const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - box.width - 8));
      /* 箭头对准单元格中心，同时夹在气泡内部（别顶到圆角上） */
      const arrow = Math.round(Math.min(
        Math.max(16, anchor.left + anchor.width / 2 - left - 5),
        Math.max(16, box.width - 26)
      ));

      setBubblePos({ top: Math.round(top), left: Math.round(left), arrow, placement });
    };

    place();

    const frame = window.requestAnimationFrame(place);
    const observer = new ResizeObserver(place);

    if (bubbleRef.current)
      observer.observe(bubbleRef.current);

    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [bubbleEdit, editing]);

  /** 气泡的初始尺寸：宽度跟单元格走，高度按行数估一个合适值（之后用户可自由缩放） */
  function bubbleSizeFor(value: string, cellWidth?: number) {
    const lines = value.split("\n").length;

    return {
      width: Math.round(Math.min(460, Math.max(320, cellWidth ?? 320))),
      height: Math.round(Math.min(360, Math.max(180, lines * 21 + 116)))
    };
  }

  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  /* 列变了（换了结果集）→ 丢掉旧的手动宽度 + 重算自适应宽度 */
  const columnSignature = columns.map(column => `${column.label}|${column.type}`).join("\u0001");

  useEffect(() => {
    setManualWidths({});
  }, [columnSignature]);

  useEffect(() => {
    setAutoWidths(measureColumns(columns, rows, fontSize));
  }, [columnSignature, rows, fontSize]);

  /*
   * 全表搜索：按任意单元格内容过滤显示行（忽略大小写、纯子串，同 FX 版）。
   * 保留真实行号，编辑 / 脏数据标记 / 选区都以原始下标为准，不会因过滤而错行。
   */
  const keyword = search.trim().toLowerCase();
  const visibleRows = keyword
    ? rows.reduce<{ row: (string | null)[]; index: number }[]>((list, row, index) => {
        if (row.some(cell => cell !== null && String(cell).toLowerCase().includes(keyword)))
          list.push({ row, index });

        return list;
      }, [])
    : rows.map((row, index) => ({ row, index }));

  useEffect(() => {
    onSearchHitsChange?.(keyword ? visibleRows.length : null);
  }, [keyword, visibleRows.length, onSearchHitsChange]);

  /*
   * 选区范围：
   * - 行号列（#）起拖 → 整行选中（列范围全宽）
   * - 列头起拖 → 整列选中（行范围全高）
   * - 数据单元格起拖 → 矩形框选
   */
  const bounds = anchor && focus
    ? (rowMode
        ? { r1: Math.min(anchor.row, focus.row), r2: Math.max(anchor.row, focus.row), c1: 0, c2: Math.max(0, columns.length - 1) }
        : colMode
          ? { r1: 0, r2: Math.max(0, rows.length - 1), c1: Math.min(anchor.col, focus.col), c2: Math.max(anchor.col, focus.col) }
          : {
              r1: Math.min(anchor.row, focus.row), r2: Math.max(anchor.row, focus.row),
              c1: Math.min(anchor.col, focus.col), c2: Math.max(anchor.col, focus.col)
            })
    : null;

  useEffect(() => {
    if (!bounds || !focus)
      return;

    /*
     * 上报的选区要按「当前可见的行」算：搜索过滤时被隐藏的行不算在内，
     * 否则按范围做删除 / 置空会连带改掉看不见的数据。
     */
    const rowList = visibleRows
      .map(item => item.index)
      .filter(index => index >= bounds.r1 && index <= bounds.r2);
    const colList = Array.from({ length: bounds.c2 - bounds.c1 + 1 }, (_, offset) => bounds.c1 + offset);

    onSelectionChange?.({
      r1: bounds.r1,
      r2: bounds.r2,
      c1: bounds.c1,
      c2: bounds.c2,
      row: focus.row,
      col: focus.col,
      rows: rowList.length,
      cols: colList.length,
      rowList,
      colList
    });
  }, [
    bounds?.r1, bounds?.r2, bounds?.c1, bounds?.c2, focus?.row, focus?.col,
    /* 过滤条件变了，可见行也跟着变 */
    keyword, visibleRows.length
  ]);

  const columnStyle = (index: number) => {
    const width = manualWidths[index] ?? autoWidths[index];

    return width ? { width, minWidth: width, maxWidth: width } : undefined;
  };

  /* 拖动表头右边缘改列宽，双击恢复自适应 */
  function startResize(index: number, event: ReactMouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();

    const header = event.currentTarget.parentElement;
    const startWidth = header ? header.getBoundingClientRect().width : 120;
    const startX = event.clientX;

    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.max(60, Math.min(640, startWidth + moveEvent.clientX - startX));
      setManualWidths(previous => ({ ...previous, [index]: Math.round(next) }));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      lastResizeAt.current = Date.now();
    };

    document.body.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function resetWidth(index: number) {
    setManualWidths(previous => {
      const next = { ...previous };
      delete next[index];
      return next;
    });
  }

  function startEdit(cell: CellRef, cellElement?: HTMLElement) {
    if (!editable)
      return;

    const value = rows[cell.row]?.[cell.col] ?? "";
    const multiline = value.includes("\n");

    committing.current = false;
    setEditing(cell);
    setDraft(value);
    /* 含换行的文本用气泡里的多行编辑器 */
    setBubbleEdit(multiline);
    setBubbleSize(multiline
      ? bubbleSizeFor(value, cellElement?.getBoundingClientRect().width)
      : null);
  }

  function commitEdit() {
    if (!editing || committing.current)
      return;

    committing.current = true;
    const current = rows[editing.row]?.[editing.col] ?? null;

    if (draft !== current)
      onCellCommit?.(editing.row, editing.col, draft);

    setEditing(null);
    setBubbleEdit(false);
    setBubbleSize(null);
    setBubblePos(null);
  }

  /** 放弃这次编辑（Escape / 气泡上的取消按钮） */
  function cancelEdit() {
    setEditing(null);
    setBubbleEdit(false);
    setBubbleSize(null);
    setBubblePos(null);
  }

  /* 气泡编辑时点空白处提交，行为与单元格内联输入框的失焦提交一致 */
  const commitRef = useRef(commitEdit);
  commitRef.current = commitEdit;

  useEffect(() => {
    if (!bubbleEdit || !editing)
      return;

    const onMouseDown = (event: MouseEvent) => {
      if (bubbleRef.current?.contains(event.target as Node))
        return;

      commitRef.current();
    };

    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [bubbleEdit, editing]);

  /**
   * 单元格左键按下：无论当前是否在编辑、是否有菜单打开，
   * 都先落定（提交编辑/关菜单由外层组件负责），再开始新的框选。
   */
  function startSelection(event: ReactMouseEvent<HTMLElement>, cell: CellRef, mode: "cell" | "row" | "col" = "cell") {
    if (event.button !== 0)
      return;

    /* 点在正在编辑的输入框里：交给输入框自己处理（定位光标、选中文字） */
    if ((event.target as HTMLElement).closest(".cell-editor"))
      return;

    event.preventDefault();

    /* 正在编辑别的单元格：先提交再框选 */
    if (editing)
      commitEdit();

    dragging.current = true;
    setRowMode(mode === "row");
    setColMode(mode === "col");
    setAnchor(cell);
    setFocus(cell);
  }

  if (columns.length === 0)
    return <div className="empty">执行结果将显示在这里</div>;

  return (
    <div className="grid-wrap" ref={wrapRef}>
      <table className={`grid${editable ? " is-editable" : ""}${refreshing ? " is-refreshing" : ""}`}>
        <thead>
          <tr>
            <th className="rownum">#</th>
            {columns.map((column, index) => (
              <th
                key={index}
                className={[
                  isNumericType(column.type) ? "is-num" : "",
                  /* 整列选中：列头同样用深蓝 */
                  colMode && bounds && index >= bounds.c1 && index <= bounds.c2
                    ? "is-col-selected"
                    : ""
                ].filter(Boolean).join(" ") || undefined}
                style={columnStyle(index)}
                title={`${column.label} · ${column.type}`}
                onMouseDown={event => {
                  if (Date.now() - lastResizeAt.current < 250)
                    return;

                  startSelection(event, { row: 0, col: index }, "col");
                }}
                onMouseEnter={() => {
                  /* 按住列头横向拖：整列选区跟着扩展 */
                  if (dragging.current && colMode)
                    setFocus(previous => ({ row: previous?.row ?? 0, col: index }));
                }}
              >
                <span className="grid-col">
                  {column.primary && <Icon name="key" size={11} className="key-icon" />}
                  {column.label}
                </span>
                <span className="grid-type">
                  {column.type}
                  {column.notNull ? " · NOT NULL" : ""}
                </span>
                <span
                  className="col-resizer"
                  role="separator"
                  aria-label={`调整 ${column.label} 列宽`}
                  onMouseDown={event => startResize(index, event)}
                  onDoubleClick={() => resetWidth(index)}
                />
              </th>
            ))}
            {/* 占位列：把表头背景铺到容器右边缘 */}
            <th className="grid-filler" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {visibleRows.map(({ row, index: rowIndex }) => {
            const dirty = dirtyRows.includes(rowIndex);
            /* 当前单元格所在整行：浅蓝底（整行/整列选中时由各自规则接管） */
            const rowActive = !rowMode && !colMode && focus != null && focus.row === rowIndex;

            return (
              <tr
                key={rowIndex}
                className={[dirty ? "is-dirty" : "", rowActive ? "is-row-active" : ""].filter(Boolean).join(" ") || undefined}
              >
                <td
                  /* 只有从 # 列拖出去选整行时行号列才跟着变深；自由框选/整列选中都不动 # 列 */
                  className={`rownum${rowMode && bounds && rowIndex >= bounds.r1 && rowIndex <= bounds.r2 ? " is-range" : ""}`}
                  onMouseDown={event => startSelection(event, { row: rowIndex, col: 0 }, "row")}
                  onMouseEnter={() => {
                    /* 按住行号列往下拖：整行选区跟着扩展 */
                    if (dragging.current && rowMode)
                      setFocus(previous => ({ row: rowIndex, col: previous?.col ?? 0 }));
                  }}
                >
                  {offset + rowIndex + 1}
                </td>
                {row.map((cell, cellIndex) => {
                  const isEditing = editing?.row === rowIndex && editing.col === cellIndex;
                  const inRange = bounds != null
                    && rowIndex >= bounds.r1 && rowIndex <= bounds.r2
                    && cellIndex >= bounds.c1 && cellIndex <= bounds.c2;

                  const classes = [
                    isNumericType(columns[cellIndex]?.type) ? "is-num" : "",
                    cell === null ? "is-null" : "",
                    isEditing ? "is-editing" : "",
                    /* 整列选中：选中的列深蓝，其他列不加底色 */
                    colMode && inRange ? "is-col-selected" : "",
                    /* 框选 / 整行选中：范围内都是深蓝（整列选中由上面那条接管） */
                    inRange && !colMode ? "is-range" : "",
                    /* 当前单元格深蓝（整行 / 整列选中时没有单一“当前单元格”） */
                    !rowMode && !colMode && focus?.row === rowIndex && focus.col === cellIndex ? "is-focus" : ""
                  ].filter(Boolean).join(" ");

                  return (
                    <td
                      key={cellIndex}
                      className={classes || undefined}
                      style={columnStyle(cellIndex)}
                      onMouseDown={event => startSelection(event, { row: rowIndex, col: cellIndex })}
                      onMouseEnter={() => {
                        if (dragging.current)
                          setFocus({ row: rowIndex, col: cellIndex });
                      }}
                      onDoubleClick={event => startEdit({ row: rowIndex, col: cellIndex }, event.currentTarget as HTMLElement)}
                      onContextMenu={event => {
                        event.preventDefault();

                        /* 右键点在已选区域内时保留原选区，只弹菜单 */
                        if (!inRange) {
                          setAnchor({ row: rowIndex, col: cellIndex });
                          setFocus({ row: rowIndex, col: cellIndex });
                        }

                        onContextMenu?.();
                      }}
                    >
                      {isEditing && !bubbleEdit ? (
                        <input
                          ref={inputRef}
                          className="cell-editor"
                          value={draft}
                          aria-label="编辑单元格"
                          onChange={event => setDraft(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") {
                              event.preventDefault();

                              /* Shift / Alt + Enter：转成多行编辑气泡，并换到下一行 */
                              if (event.shiftKey || event.altKey) {
                                const next = `${draft}\n`;

                                setDraft(next);
                                setBubbleEdit(true);
                                setBubbleSize(bubbleSizeFor(
                                  next,
                                  wrapRef.current?.querySelector("td.is-editing")?.getBoundingClientRect().width
                                ));
                                return;
                              }

                              commitEdit();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelEdit();
                            }
                          }}
                          onBlur={commitEdit}
                        />
                      ) : (cell === null ? "NULL" : highlight(String(cell), keyword))}
                    </td>
                  );
                })}
                {/* 占位列：斑马纹 / 当前行 / 脏数据 / 整行选中的底色一起铺满整行 */}
                <td
                  className={`grid-filler${rowMode && bounds && rowIndex >= bounds.r1 && rowIndex <= bounds.r2 ? " is-range" : ""}`}
                  aria-hidden="true"
                />
              </tr>
            );
          })}
          {/* 全表搜索没有命中时给一行提示，避免表格看起来是空的 */}
          {keyword && visibleRows.length === 0 && (
            <tr className="grid-none">
              <td colSpan={columns.length + 2}>没有匹配“{search.trim()}”的数据</td>
            </tr>
          )}
        </tbody>
      </table>

      {rows.length === 0 && <div className="empty">没有数据</div>}

      {/* 多行编辑气泡：贴着单元格上方或下方浮出，⌘/Ctrl+Enter 保存、Esc 取消 */}
      {bubbleEdit && editing && bubbleSize && bubblePos && (
        <div
          className={`cell-bubble-anchor is-${bubblePos.placement}`}
          ref={bubbleRef}
          style={{ top: bubblePos.top, left: bubblePos.left }}
          onMouseDown={event => event.stopPropagation()}
        >
          {/* 三角箭头：指向正在编辑的单元格 */}
          <span className="cell-bubble-arrow" style={{ left: bubblePos.arrow }} aria-hidden="true" />

          <div className="cell-bubble" style={{ width: bubbleSize.width, height: bubbleSize.height }}>
            <div className="cell-bubble-head">
              <span className="cell-bubble-title">{columns[editing.col]?.label ?? "单元格"} · 多行编辑</span>
              <span className="cell-bubble-hint">Enter 换行 · {KEY.runEnter} 保存 · Esc 取消</span>
            </div>

            <textarea
              ref={textareaRef}
              className="cell-bubble-input"
              value={draft}
              spellCheck={false}
              aria-label="多行编辑单元格"
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelEdit();
                } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  commitEdit();
                }
              }}
            />

            <div className="cell-bubble-actions">
              <span className="cell-bubble-count">{draft.split("\n").length} 行 · {draft.length} 字符</span>
              <span className="tbtn-push" aria-hidden="true" />
              <button type="button" className="mini-btn" onClick={cancelEdit}>取消</button>
              <button type="button" className="mini-btn is-default" onClick={commitEdit}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
