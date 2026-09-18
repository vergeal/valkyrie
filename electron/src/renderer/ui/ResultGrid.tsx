import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { isNumericType, type QueryColumn } from "../api";
import { rowMatchesKeyword } from "../result/resultHelpers";
import { KEY } from "../keys";
import { DateTimePicker } from "./DateTimePicker";
import { JsonTextArea } from "./JsonTextArea";
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
  /** 表头显示字段类型（第二行小字） */
  showTypes?: boolean;
  /** 右键单元格（外层据此弹出系统原生菜单） */
  onContextMenu?: () => void;
  offset?: number;
  editable?: boolean;
  dirtyRows?: number[];
  /** 标记为待删除（还没提交）的行：显示成划掉的样子，提交后才消失 */
  deletedRows?: number[];
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

/* 与 styles.css 里 table.grid 的字体保持一致：从 --grid-font 读，改字体后列宽才量得准 */
const GRID_FONT_FALLBACK = 'Consolas, "Cascadia Mono", "Courier New", monospace';
const CELL_PADDING = 20;
const MIN_COLUMN_WIDTH = 64;
/* 列宽上限收窄：超长内容改为换行显示，而不是把列撑得很宽 */
const MAX_COLUMN_WIDTH = 320;
const MEASURE_ROWS = 200;
const MEASURE_CHARS = 60;

let measureContext: CanvasRenderingContext2D | null = null;

/** 气泡编辑器的类型：多行文本 / 日期 / 日期时间 / 时间 */
type BubbleMode = "text" | "date" | "datetime" | "time";

/**
 * 判断字段是不是时间类：各数据库命名不同（DATE / DATETIME / TIMESTAMP[TZ] /
 * TIME[TZ] / SMALLDATETIME…），命中就在气泡里给日期时间选择器。
 */
function timeKindOf(type: string | undefined): "date" | "datetime" | "time" | null {
  const lower = (type ?? "").toLowerCase();

  if (!lower)
    return null;

  if (lower.includes("timestamp") || lower.includes("datetime"))
    return "datetime";

  if (/(^|\W)time(\W|$)/.test(lower))
    return "time";

  if (/(^|\W)date(\W|$)/.test(lower))
    return "date";

  return null;
}

/** 单元格里的时间文本 → 选择器要的值（宽松解析：容忍 T 分隔符与毫秒） */
function toPickerValue(value: string, kind: "date" | "datetime" | "time"): string {
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  /* 只认「开头 / 空格 / T」后面的 HH:MM[:SS]，避免把 MySQL 的 838:59:59 这类超长 TIME 误解析 */
  const time = /(?:^|\s|T)(\d{1,2}:\d{2})(?::(\d{2}))?/.exec(value);
  const datePart = date ? date[1] : "";
  const timePart = time ? `${time[1]}:${time[2] ?? "00"}` : "";

  if (kind === "date")
    return datePart;

  if (kind === "time")
    return timePart;

  return datePart && timePart ? `${datePart}T${timePart}` : "";
}

/**
 * 选择器值 → 写回数据库的文本。
 * 原值带毫秒且秒没被改动时保留毫秒，避免选一次日期就把 .123 抹掉。
 */
function fromPickerValue(picked: string, kind: "date" | "datetime" | "time", original: string): string {
  if (kind === "date")
    return picked;

  if (kind === "time")
    return picked.length === 5 ? `${picked}:00` : picked;

  const normalized = picked.replace("T", " ");
  const fraction = /\.\d+/.exec(original)?.[0] ?? "";
  const unchanged = normalized.slice(0, 19) === toPickerValue(original, "datetime").replace("T", " ");

  return fraction && unchanged ? `${normalized}${fraction}` : normalized;
}

/** 气泡标题后缀 */
const BUBBLE_LABEL: Record<BubbleMode, string> = {
  text: "多行编辑",
  date: "日期",
  datetime: "日期时间",
  time: "时间"
};

/** 「现在 / 今天 / 明天」按钮：按模式给出当前日期 / 日期时间 / 时间的控件值 */
function nowFor(kind: "date" | "datetime" | "time", dayOffset = 0): string {
  const now = new Date();

  if (dayOffset)
    now.setDate(now.getDate() + dayOffset);

  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  if (kind === "date")
    return date;

  if (kind === "time")
    return time;

  return `${date}T${time}`;
}

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

  const family = typeof window === "undefined"
    ? GRID_FONT_FALLBACK
    : getComputedStyle(document.documentElement).getPropertyValue("--grid-font").trim() || GRID_FONT_FALLBACK;

  measureContext.font = `${fontSize}px ${family}`;

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
    columns, rows, flashToken = 0, fontSize = 14, offset = 0, editable = false, dirtyRows = [], deletedRows = [],
    search = "", showTypes = true, onSearchHitsChange, onCellCommit, onSelectionChange, onContextMenu
  } = props;
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [focus, setFocus] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<CellRef | null>(null);
  const [draft, setDraft] = useState("");
  /* 气泡编辑：多行文本 / 日期时间选择；null 表示走单元格内的内联输入框 */
  const [bubbleMode, setBubbleMode] = useState<BubbleMode | null>(null);
  /* 尺寸只在打开时算一次：之后用户可以自由缩放，滚动重定位不覆盖它 */
  const [bubbleSize, setBubbleSize] = useState<{ width: number; height: number } | null>(null);
  /* 气泡里手输的日期时间不合法时，禁止提交 */
  const [bubbleInvalid, setBubbleInvalid] = useState(false);
  const [bubblePos, setBubblePos] = useState<{
    top: number; left: number; arrow: number; placement: "below" | "above";
  } | null>(null);
  /* 选区模式：整行（从行号列拖）/ 矩形（从数据单元格拖） */
  const [rowMode, setRowMode] = useState(false);
  /* 整列（从列头拖） */
  const [colMode, setColMode] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /* 挂载时的初始计数：首屏（首次加载）本来就没有旧内容可换，不该闪 */
  const initialFlash = useRef(flashToken);
  /* 上一次闪烁的结束时刻：短时间内的连续信号合并成一次，避免连闪 */
  const flashUntil = useRef(0);

  /* 刷新反馈：内容先清空一瞬再重新出现（不弹提示） */
  useEffect(() => {
    if (flashToken === initialFlash.current || Date.now() < flashUntil.current)
      return;

    flashUntil.current = Date.now() + 140;
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
  const cardRef = useRef<HTMLDivElement | null>(null);

  /*
   * 虚拟滚动：只渲染视口附近的行，数据上千条也不卡。
   * 行高统一（单行 + 省略号），用实测值算窗口；测到之前按字号估一个，
   * 免得首帧把整份结果一次性渲染出来。
   */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof window === "undefined" ? 600 : window.innerHeight
  );
  const [rowHeight, setRowHeight] = useState(0);
  const measureRowRef = useRef<HTMLTableRowElement | null>(null);
  const scrollFrame = useRef(0);

  /* 容器尺寸变化（面板缩放 / 窗口大小）时重算可见行数 */
  useEffect(() => {
    const wrap = wrapRef.current;

    if (!wrap)
      return;

    const update = () => setViewportHeight(wrap.clientHeight);

    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.cancelAnimationFrame(scrollFrame.current), []);

  useEffect(() => {
    if (!editing)
      return;

    if (bubbleMode === "text") {
      const area = textareaRef.current;

      area?.focus();
      /* 光标落到末尾：接着往下写不用先点一下 */
      area?.setSelectionRange(area.value.length, area.value.length);
      return;
    }

    if (bubbleMode) {
      /* 键盘事件由气泡容器统一处理，焦点落在卡片上即可 */
      cardRef.current?.focus();
      return;
    }

    inputRef.current?.focus();
  }, [editing, bubbleMode]);

  /*
   * 气泡定位：贴着正在编辑的单元格浮出 —— 下方放得下就放下方，放不下翻到上方，
   * 左右再夹到窗口内，并按单元格中心算三角箭头的水平位置。
   * 表格内部滚动、窗口缩放、气泡被手动缩放时都重新贴一次。
   */
  useLayoutEffect(() => {
    if (!bubbleMode || !editing) {
      setBubblePos(null);
      return;
    }

    const place = () => {
      const anchor = wrapRef.current?.querySelector("td.is-editing")?.getBoundingClientRect();

      if (!anchor)
        return;

      /* 首帧还量不到气泡自己，先用打开时的尺寸兜底 */
      const box = bubbleRef.current?.getBoundingClientRect();
      const size = {
        width: box?.width ?? bubbleSize?.width ?? 340,
        height: box?.height ?? bubbleSize?.height ?? 200
      };
      const next = placeBubble(anchor, size);

      /* 位置没变就不写 state，免得和 ResizeObserver 互相触发 */
      setBubblePos(previous => previous
        && previous.top === next.top
        && previous.left === next.left
        && previous.arrow === next.arrow
        && previous.placement === next.placement
          ? previous
          : next);
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
  }, [bubbleMode, editing, bubbleSize]);

  interface BubblePos {
    top: number;
    left: number;
    arrow: number;
    placement: "below" | "above";
  }

  /** 由单元格矩形 + 气泡尺寸算位置：下方放不下翻到上方，左右夹窗口内，箭头对准单元格中心 */
  function placeBubble(anchor: DOMRect, size: { width: number; height: number }): BubblePos {
    const spaceBelow = window.innerHeight - anchor.bottom;
    const placement: BubblePos["placement"] = spaceBelow >= size.height + 14 ? "below" : "above";
    const top = placement === "below"
      ? anchor.bottom + 8
      : Math.max(8, anchor.top - size.height - 8);
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - size.width - 8));
    /* 箭头对准单元格中心，同时夹在气泡内部（别顶到圆角上） */
    const arrow = Math.round(Math.min(
      Math.max(16, anchor.left + anchor.width / 2 - left - 5),
      Math.max(16, size.width - 26)
    ));

    return { top: Math.round(top), left: Math.round(left), arrow, placement };
  }

  /* 打开气泡：尺寸与位置立刻算好，不用等气泡渲染出来（否则首帧没得量） */
  function openBubble(mode: BubbleMode, value: string, cell?: HTMLElement) {
    const rect = cell?.getBoundingClientRect()
      ?? wrapRef.current?.querySelector("td.is-editing")?.getBoundingClientRect();
    const size = bubbleSizeFor(mode, value, rect?.width);

    setBubbleMode(mode);
    setBubbleSize(size);
    setBubblePos(rect ? placeBubble(rect, size) : null);
    setBubbleInvalid(false);
  }

  /** 气泡的初始尺寸：宽度跟单元格走，高度按内容估一个合适值（之后用户可自由缩放） */
  function bubbleSizeFor(mode: BubbleMode, value: string, cellWidth?: number) {
    /* 多行文本按行数估高度；日期是月历网格，日期时间再加一行时分秒 */
    const content = mode === "text"
      ? value.split("\n").length * 21 + 116
      : mode === "datetime" ? 416 : mode === "date" ? 350 : 214;

    return {
      width: Math.round(Math.min(460, Math.max(320, cellWidth ?? 320))),
      height: Math.round(Math.min(520, Math.max(mode === "text" ? 180 : 200, content)))
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
  const visibleRows = useMemo(() => {
    if (!keyword)
      return rows.map((row, index) => ({ row, index }));

    const list: { row: (string | null)[]; index: number }[] = [];

    rows.forEach((row, index) => {
      /* 与全局替换共用同一套「可见行」判定，避免过滤范围不一致 */
      if (rowMatchesKeyword(row, keyword))
        list.push({ row, index });
    });

    return list;
  }, [rows, keyword]);

  useEffect(() => {
    onSearchHitsChange?.(keyword ? visibleRows.length : null);
  }, [keyword, visibleRows.length, onSearchHitsChange]);

  /* 实测第一行的高度，替换按字号估的近似值（字号 / 列 / 数据变了要重新量） */
  useLayoutEffect(() => {
    const height = measureRowRef.current?.getBoundingClientRect().height;

    if (height)
      setRowHeight(Math.round(height));
  }, [fontSize, columnSignature, visibleRows.length]);

  /*
   * 可见行窗口：按滚动位置 + 容器高度换算成下标区间，上下各留几行缓冲，
   * 其余用两个等高的占位行把滚动条撑住。行高没实测到之前按字号估。
   */
  const rowHeightEstimate = Math.max(1, Math.round(fontSize * 1.3 + 9));
  const effectiveRowHeight = rowHeight || rowHeightEstimate;
  const totalRows = visibleRows.length;
  const overscan = 8;
  const windowStart = totalRows === 0
    ? 0
    : Math.max(0, Math.floor(scrollTop / effectiveRowHeight) - overscan);
  const windowEnd = totalRows === 0
    ? 0
    : Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / effectiveRowHeight) + overscan);
  const topSpacer = windowStart * effectiveRowHeight;
  const bottomSpacer = Math.max(0, (totalRows - windowEnd) * effectiveRowHeight);
  const renderedRows = visibleRows.slice(windowStart, windowEnd);
  const firstRenderedIndex = renderedRows[0]?.index;

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
    const timeKind = timeKindOf(columns[cell.col]?.type);

    committing.current = false;
    setEditing(cell);
    setDraft(value);

    /* 含换行的文本用多行编辑器；时间类字段用气泡里的日期时间选择器 */
    if (multiline)
      openBubble("text", value, cellElement);
    else if (timeKind)
      openBubble(timeKind, value, cellElement);
    else
      setBubbleMode(null);
  }

  function commitEdit() {
    if (!editing || committing.current)
      return;

    committing.current = true;
    const current = rows[editing.row]?.[editing.col] ?? null;

    if (bubbleInvalid)
      return;

    if (draft !== current)
      onCellCommit?.(editing.row, editing.col, draft);

    setEditing(null);
    setBubbleMode(null);
    setBubbleSize(null);
    setBubblePos(null);
    setBubbleInvalid(false);
  }

  /** 放弃这次编辑（Escape / 气泡上的取消按钮） */
  function cancelEdit() {
    setEditing(null);
    setBubbleMode(null);
    setBubbleSize(null);
    setBubblePos(null);
    setBubbleInvalid(false);
  }

  /* 气泡编辑时点空白处提交，行为与单元格内联输入框的失焦提交一致 */
  const commitRef = useRef(commitEdit);
  commitRef.current = commitEdit;

  /* 内联输入框失焦提交要用 ref 判断：切到气泡那一次渲染后输入框会卸载 */
  const bubblingRef = useRef(false);
  bubblingRef.current = bubbleMode !== null;

  useEffect(() => {
    if (!bubbleMode || !editing)
      return;

    const onMouseDown = (event: MouseEvent) => {
      if (bubbleRef.current?.contains(event.target as Node))
        return;

      commitRef.current();
    };

    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [bubbleMode, editing]);

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

  /**
   * 点行号列表头（左上角 #）：整行模式选中当前显示的全部行。
   *
   * 走的是和行号列一样的「整行选区」，所以整行宽度、复制 / 导出 / 删除这些
   * 按选区生效的动作都当成全选处理；搜索过滤时被隐藏的行不算在内。
   */
  function selectAllRows(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0)
      return;

    event.preventDefault();

    /* 正在编辑别的单元格：先提交再改选区（与拖选一致） */
    if (editing)
      commitEdit();

    /* 不从左上角拉框：拖拽扩展交给行号列本身 */
    dragging.current = false;
    setRowMode(true);
    setColMode(false);
    setAnchor({ row: 0, col: 0 });
    setFocus({ row: Math.max(0, rows.length - 1), col: Math.max(0, columns.length - 1) });
  }

  if (columns.length === 0)
    return <div className="empty">执行结果将显示在这里</div>;

  return (
    <div
      className="grid-wrap"
      ref={wrapRef}
      onScroll={event => {
        /* 一帧只跟一次：滚动过程中连续 setState 会拖慢滚动 */
        const top = event.currentTarget.scrollTop;

        window.cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = window.requestAnimationFrame(() => setScrollTop(top));
      }}
    >
      <table className={`grid${editable ? " is-editable" : ""}${refreshing ? " is-refreshing" : ""}`}>
        <thead>
          <tr>
            <th className="rownum" title="选中所有行" onMouseDown={selectAllRows}>#</th>
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
                  {showTypes ? `${column.type}${column.notNull ? " · NOT NULL" : ""}` : ""}
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
          {/* 上方占位行：把被窗口裁掉的行高撑出来，滚动条长度不变 */}
          {topSpacer > 0 && (
            <tr className="grid-spacer" aria-hidden="true">
              <td colSpan={columns.length + 2} style={{ height: topSpacer }} />
            </tr>
          )}
          {renderedRows.map(({ row, index: rowIndex }) => {
            const dirty = dirtyRows.includes(rowIndex);
            /* 待删除（还没提交）：划掉，提交之后才会真的从结果里消失 */
            const deleted = deletedRows.includes(rowIndex);
            /* 当前单元格所在整行：浅蓝底（整行/整列选中时由各自规则接管） */
            const rowActive = !rowMode && !colMode && focus != null && focus.row === rowIndex;

            return (
              <tr
                key={rowIndex}
                ref={rowIndex === firstRenderedIndex ? measureRowRef : undefined}
                className={[
                  dirty ? "is-dirty" : "",
                  deleted ? "is-deleted" : "",
                  rowActive ? "is-row-active" : ""
                ].filter(Boolean).join(" ") || undefined}
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
                  onContextMenu={event => {
                    /* 右键行号 = 整行：没选中这行时先把整行选上，再弹同一套结果表菜单 */
                    event.preventDefault();

                    if (!(rowMode && bounds && rowIndex >= bounds.r1 && rowIndex <= bounds.r2)) {
                      setRowMode(true);
                      setColMode(false);
                      setAnchor({ row: rowIndex, col: 0 });
                      setFocus({ row: rowIndex, col: Math.max(0, columns.length - 1) });
                    }

                    onContextMenu?.();
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
                      {isEditing && !bubbleMode ? (
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
                                openBubble("text", next);
                                return;
                              }

                              commitEdit();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelEdit();
                            }
                          }}
                          /* 切到气泡时输入框会卸载，别把这次切换当成失焦提交 */
                          onBlur={() => { if (!bubblingRef.current) commitEdit(); }}
                        />
                      ) : (cell === null ? "NULL" : highlight(String(cell), keyword))}
                    </td>
                  );
                })}
                {/* 占位列：只为撑满宽度，本身没有内容也不上任何底色 */}
                <td className="grid-filler" aria-hidden="true" />
              </tr>
            );
          })}
          {/* 下方占位行：撑住滚动条剩余高度 */}
          {bottomSpacer > 0 && (
            <tr className="grid-spacer" aria-hidden="true">
              <td colSpan={columns.length + 2} style={{ height: bottomSpacer }} />
            </tr>
          )}
          {/* 全表搜索没有命中时给一行提示，避免表格看起来是空的 */}
          {keyword && visibleRows.length === 0 && (
            <tr className="grid-none">
              <td colSpan={columns.length + 2}>没有匹配“{search.trim()}”的数据</td>
            </tr>
          )}
        </tbody>
      </table>

      {rows.length === 0 && <div className="empty">没有数据</div>}

      {/*
        * 编辑气泡：贴着单元格上方或下方浮出，⌘/Ctrl+Enter 保存、Esc 取消。
        * 用 portal 挂到 body：面板会形成自己的层叠上下文，气泡留在面板里时，
        * 面板边缘的分隔条（splitter，z-index 5）会盖在气泡上面把鼠标抢走。
        */}
      {bubbleMode && editing && bubbleSize && bubblePos && createPortal((
        <div
          className={`cell-bubble-anchor is-${bubblePos.placement}`}
          ref={bubbleRef}
          style={{ top: bubblePos.top, left: bubblePos.left }}
          /*
           * 气泡里的鼠标操作全部就地消化，不冒泡给底下的表格 ——
           * 之前只挡住了 mousedown，点选 / 双击 / 右键 / 滚轮还会漏到网格上，
           * 于是拖气泡、右键气泡都可能触发背景的框选或菜单。
           */
          onMouseDown={event => event.stopPropagation()}
          onMouseUp={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
          onWheel={event => event.stopPropagation()}
          onContextMenu={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {/* 三角箭头：指向正在编辑的单元格 */}
          <span className="cell-bubble-arrow" style={{ left: bubblePos.arrow }} aria-hidden="true" />

          <div
            className="cell-bubble"
            ref={cardRef}
            /* 容器可聚焦：焦点落在气泡里，Esc / ⌘+Enter 才收得到键盘事件 */
            tabIndex={-1}
            style={{ width: bubbleSize.width, height: bubbleSize.height }}
            onKeyDown={event => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();

                /* 时间选择器没选值时不提交，避免把空串写进日期字段 */
                if (bubbleMode === "text" || draft)
                  commitEdit();
              }
            }}
          >
            <div className="cell-bubble-head">
              <span className="cell-bubble-title">
                {columns[editing.col]?.label ?? "单元格"} · {BUBBLE_LABEL[bubbleMode]}
              </span>
              <span className="cell-bubble-hint">
                {bubbleMode === "text" ? "Enter 换行 · " : ""}{KEY.runEnter} 保存 · Esc 取消
              </span>
            </div>

            {bubbleMode === "text" ? (
              <JsonTextArea
                textareaRef={textareaRef}
                className="cell-bubble-input"
                value={draft}
                spellCheck={false}
                ariaLabel="多行编辑单元格"
                onChange={setDraft}
              />
            ) : (
              /* 时间类字段：自绘的日期时间选择器（原生控件的分段编辑和系统面板样式改不动） */
              <DateTimePicker
                mode={bubbleMode}
                value={toPickerValue(draft, bubbleMode)}
                onChange={next => setDraft(fromPickerValue(next, bubbleMode, draft))}
                onValidityChange={setBubbleInvalid}
              />
            )}

            <div className="cell-bubble-actions">
              <span className="cell-bubble-count">
                {bubbleMode === "text" ? `${draft.split("\n").length} 行 · ${draft.length} 字符` : (draft || "未选择")}
              </span>
              <span className="tbtn-push" aria-hidden="true" />
              {bubbleMode === "date" && (
                <>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => setDraft(fromPickerValue(nowFor("date"), "date", draft))}
                  >
                    今天
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => setDraft(fromPickerValue(nowFor("date", 1), "date", draft))}
                  >
                    明天
                  </button>
                </>
              )}
              {bubbleMode !== "text" && (
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => setDraft(fromPickerValue(nowFor(bubbleMode), bubbleMode, draft))}
                >
                  现在
                </button>
              )}
              <button type="button" className="mini-btn" onClick={cancelEdit}>取消</button>
              <button
                type="button"
                className="mini-btn is-default"
                /* 时间选择器没选值时不提交，避免把空串写进日期字段 */
                disabled={bubbleMode !== "text" && (!draft || bubbleInvalid)}
                onClick={commitEdit}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
