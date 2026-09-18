/**
 * 执行日志面板。
 *
 * 数据层把一次执行拆成若干进度事件（execute / query / update / skip / rows / cost），
 * 这里先把它们聚合成「批次 → 语句 → 结果」，再按日志查看器的方式呈现：
 * 序号 + 毫秒时间戳 + 类型标签 + 语句正文 + 行数/耗时指标，失败单独高亮。
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { ProgressEvent } from "../api";
import { Icon } from "./icons";

/* ------------------------------ 日志模型 ------------------------------ */

export type LogKind = "execute" | "query" | "update" | "skip" | "rows" | "cost" | "error";

/** 会独占一行日志的语句类型 */
export type StatementKind = "execute" | "query" | "update" | "skip";

export interface LogRecord {
  id: number;
  /** 一次 query.execute 调用对应一个 jobId，用来把语句归到同一批 */
  jobId?: number;
  time: number;
  kind: LogKind;
  detail: string;
}

export interface LogStatement {
  key: string;
  /** 全局语句序号：筛选后编号不跳变，方便和上一次执行对照 */
  index: number;
  time: number;
  kind: StatementKind;
  sql: string;
  rows?: number;
  costMs?: number;
}

export interface LogFailure {
  key: string;
  time: number;
  message: string;
}

export interface LogBatch {
  key: string;
  jobId?: number;
  time: number;
  statements: LogStatement[];
  failures: LogFailure[];
  rows: number;
  costMs: number;
}

const RECORD_KINDS = new Set<string>(["execute", "query", "update", "skip", "rows", "cost", "error"]);

const STATEMENT_LABEL: Record<StatementKind, string> = {
  execute: "EXECUTE",
  query: "QUERY",
  update: "UPDATE",
  skip: "SKIP"
};

const STATEMENT_HINT: Record<StatementKind, string> = {
  execute: "通用语句（DDL、事务等）",
  query: "查询语句",
  update: "更新语句",
  skip: "未执行：非末条查询语句会被跳过"
};

let recordSequence = 0;

/** 数据层进度事件 → 日志记录；与日志无关的事件返回 null */
export function progressRecord(event: ProgressEvent): LogRecord | null {
  const kind = event.kind ?? "";

  if (!RECORD_KINDS.has(kind))
    return null;

  return { id: ++recordSequence, jobId: event.jobId, time: Date.now(), kind: kind as LogKind, detail: event.detail ?? "" };
}

/** 客户端侧失败（语句执行、执行计划解析等）同样写日志；带 jobId 时并入同一批次 */
export function errorRecord(message: string, jobId?: number): LogRecord {
  return { id: ++recordSequence, jobId, time: Date.now(), kind: "error", detail: message.trim() };
}

/** 内存里保留的日志条数上限（超出后丢最老的） */
export const LOG_LIMIT = 2048;

/** 追加一条日志，超过上限时丢掉最早的记录（上限可在「选项」里配） */
export function appendLog(records: LogRecord[], record: LogRecord, limit = LOG_LIMIT): LogRecord[] {
  const next = [...records, record];

  return next.length > limit ? next.slice(-limit) : next;
}

/** 批量追加日志：一帧内合并多个事件时只复制一次数组 */
export function appendLogs(records: LogRecord[], additions: LogRecord[], limit = LOG_LIMIT): LogRecord[] {
  if (additions.length === 0)
    return records;

  const next = records.concat(additions);

  return next.length > limit ? next.slice(-limit) : next;
}

/**
 * 进度事件 → 日志批次。
 *
 * rows / cost 属于语句的附属指标，直接挂到上一条语句上（不再各占一行），
 * 这样一条语句的信息始终在一起，长日志也扫得动。
 */
function buildBatches(records: LogRecord[]): LogBatch[] {
  const batches: LogBatch[] = [];
  let batch: LogBatch | null = null;
  let statement: LogStatement | null = null;
  let index = 0;

  for (const record of records) {
    if (!batch || record.jobId !== batch.jobId) {
      batch = { key: `b${record.id}`, jobId: record.jobId, time: record.time, statements: [], failures: [], rows: 0, costMs: 0 };
      statement = null;
      batches.push(batch);
    }

    switch (record.kind) {
      case "execute":
      case "query":
      case "update":
      case "skip": {
        statement = { key: `s${record.id}`, index: ++index, time: record.time, kind: record.kind, sql: record.detail };
        batch.statements.push(statement);
        break;
      }

      case "rows": {
        const value = Number(record.detail);

        if (statement && Number.isFinite(value)) {
          statement.rows = value;
          batch.rows += value;
        }

        break;
      }

      case "cost": {
        const value = Number(record.detail);

        if (Number.isFinite(value)) {
          if (statement)
            statement.costMs = value;

          batch.costMs += value;
        }

        break;
      }

      case "error": {
        batch.failures.push({ key: `e${record.id}`, time: record.time, message: record.detail });
        break;
      }
    }
  }

  return batches;
}

/* ------------------------------ 文本格式 ------------------------------ */

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 12:31:04.512 */
function clockOf(time: number): string {
  const date = new Date(time);

  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

/** 2026-09-13 12:31:04.512 */
function stampOf(time: number): string {
  const date = new Date(time);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)} ${clockOf(time)}`;
}

/** 复制单条语句时的纯文本形式：和面板里能看到的信息保持一致 */
function statementText(statement: LogStatement): string {
  const metrics = [
    statement.rows != null ? `${statement.rows} 行` : "",
    statement.costMs != null ? `${statement.costMs} ms` : ""
  ].filter(Boolean).join(" · ");

  return `${stampOf(statement.time)} [${STATEMENT_LABEL[statement.kind]}] ${statement.sql}${metrics ? `   (${metrics})` : ""}`;
}

/* ------------------------------ 高亮 ------------------------------ */

const SQL_KEYWORDS = new Set(
  `add all alter and as asc begin between by cascade case check column commit constraint create cross
   current_date current_time current_timestamp database default delete desc distinct drop else end escape
   exists explain false foreign from full grant group having if in index inner insert into is join key
   left like limit not null offset on or order outer primary references rename replace revoke right
   rollback select set show table then true truncate union unique update use using values view when
   where with`
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.toUpperCase())
);

const SQL_PATTERN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)/g;

/** 把命中的搜索关键字标成黄底片段（与结果集搜索同一套观感） */
function hits(text: string, keyword: string, keyBase: string): ReactNode {
  if (!keyword || !text)
    return text;

  const lower = text.toLowerCase();
  const needle = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  let found = false;

  while (at >= 0) {
    found = true;

    if (at > from)
      parts.push(text.slice(from, at));

    parts.push(<mark key={`${keyBase}-${at}`} className="log-hit">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }

  if (!found)
    return text;

  if (from < text.length)
    parts.push(text.slice(from));

  return parts;
}

/** SQL 着色：注释 / 字面量 / 数字 / 关键字各一色，其余原样输出 */
function sqlNodes(sql: string, keyword: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let token = 0;
  let match: RegExpExecArray | null;

  SQL_PATTERN.lastIndex = 0;

  while ((match = SQL_PATTERN.exec(sql)) !== null) {
    const [text, comment, literal, number, word] = match;

    if (match.index > cursor)
      nodes.push(hits(sql.slice(cursor, match.index), keyword, `${keyBase}-p${token++}`));

    const className = comment
      ? "log-tok-comment"
      : literal
        ? "log-tok-literal"
        : number
          ? "log-tok-number"
          : SQL_KEYWORDS.has(word.toUpperCase())
            ? "log-tok-key"
            : "log-tok-name";

    nodes.push(<span key={`${keyBase}-t${token++}`} className={className}>{hits(text, keyword, `${keyBase}-h${token}`)}</span>);

    cursor = match.index + text.length;
  }

  if (cursor < sql.length)
    nodes.push(hits(sql.slice(cursor), keyword, `${keyBase}-tail`));

  return nodes;
}

/* ------------------------------ 面板 ------------------------------ */

type LogScope = "all" | "statement" | "failure";

interface VisibleBatch {
  batch: LogBatch;
  statements: LogStatement[];
  failures: LogFailure[];
}

interface LogConsoleProps {
  records: LogRecord[];
  /** 日志页当前是否可见：不可见时不做滚动跟随，避免隐藏状态下白跑 */
  active: boolean;
  onClear: () => void;
  onCopy: (text: string) => void;
}

/** 按类型 / 关键字过滤：批次内没有命中内容的直接不显示 */
function filterBatches(batches: LogBatch[], scope: LogScope, keyword: string): VisibleBatch[] {
  const needle = keyword.toLowerCase();
  const match = (text: string) => !needle || text.toLowerCase().includes(needle);

  return batches
    .map(batch => ({
      batch,
      statements: scope === "failure" ? [] : batch.statements.filter(statement => match(statement.sql)),
      failures: scope === "statement" ? [] : batch.failures.filter(failure => match(failure.message))
    }))
    .filter(entry => entry.statements.length > 0 || entry.failures.length > 0);
}

/** 导出当前可见内容：格式与面板一致，直接贴进工单或邮件即可 */
function exportText(entries: VisibleBatch[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    for (const statement of entry.statements)
      lines.push(statementText(statement));

    for (const failure of entry.failures)
      lines.push(`${stampOf(failure.time)} [ERROR] ${failure.message}`);
  }

  return lines.join("\n");
}

export function LogConsole({ records, active, onClear, onCopy }: LogConsoleProps) {
  const [scope, setScope] = useState<LogScope>("all");
  const [keyword, setKeyword] = useState("");
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const viewRef = useRef<HTMLDivElement | null>(null);
  /* 复制回调每次渲染都是新闭包；用 ref 取最新，避免污染下方列表的 memo 依赖 */
  const onCopyRef = useRef(onCopy);
  onCopyRef.current = onCopy;
  /*
   * 程序自己贴底时写下的滚动位置，以及「下一次滚动事件是程序补发的」这个标记。
   *
   * 贴底会补发一次滚动事件（异步的，可能晚到几十毫秒）；批量执行日志时，
   * 这些补发事件与新日志长高混在一起，按 atBottom 判断会把它们当成用户往上翻，
   * 跟随开关被误关，面板于是停在原地、看起来一路往上滚。
   */
  const pinnedTopRef = useRef(-1);
  const pinPendingRef = useRef(false);

  const batches = useMemo(() => buildBatches(records), [records]);
  const needle = keyword.trim();
  const entries = useMemo(() => filterBatches(batches, scope, needle), [batches, scope, needle]);

  const totals = useMemo(() => {
    let statements = 0;
    let failures = 0;

    for (const batch of batches) {
      statements += batch.statements.length;
      failures += batch.failures.length;
    }

    return { statements, failures, all: statements + failures };
  }, [batches]);

  const shown = useMemo(
    () => entries.reduce((total, entry) => total + entry.statements.length + entry.failures.length, 0),
    [entries]
  );

  const filtered = scope !== "all" || needle.length > 0;

  /*
   * 日志列表元素只在「可见 + 数据/筛选变化」时重建：不可见时直接返回 null，
   * 避免查询执行期间日志事件触发整棵组件树重渲染时，隐藏的日志页也反复重建上千行 DOM。
   * 元素引用稳定时 React 会跳过该子树的协调，切回日志页由 useLayoutEffect 重新贴底。
   */
  const viewContent = useMemo(() => {
    if (!active)
      return null;

    if (batches.length === 0)
      return <span className="empty">暂无日志</span>;

    if (entries.length === 0)
      return <span className="empty">没有匹配的日志</span>;

    return entries.map(renderBatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, batches, entries, needle]);

  /** 贴到最底部，并记住这次是程序自己滚的 */
  function pinToLatest() {
    const element = viewRef.current;

    if (!element)
      return;

    const before = element.scrollTop;

    element.scrollTop = element.scrollHeight;
    pinnedTopRef.current = element.scrollTop;

    /* 位置真的动了才会补发事件；没动就别挂标记，免得吃掉用户的下一次滚动 */
    if (element.scrollTop !== before)
      pinPendingRef.current = true;
  }

  /*
   * 有新日志时贴住底部；用户往上翻看历史后自动停跟，点「最新」恢复。
   *
   * 用 layout effect（而不是 effect）：日志是「先长高、再贴底」，
   * 放到绘制之后贴，批量执行时每一批新日志都会先被画在错位的位置上，
   * 看起来就是面板一跳一跳往上滚。
   */
  useLayoutEffect(() => {
    if (!active || !follow)
      return;

    pinToLatest();
  }, [records, active, follow, scope, needle]);

  function scrollToLatest() {
    setFollow(true);
    pinToLatest();
  }

  /**
   * 只有「用户自己翻走了」才停跟。
   *
   * 贴底会异步补发一次滚动事件（可能晚到几十毫秒），批量执行日志时，
   * 这些补发事件与新日志长高混在一起；只看 atBottom 会把它们当成「用户往上翻」，
   * 跟随开关被误关，面板于是停在原地、看起来一路往上滚。
   * 所以这里先把「程序刚贴过底」那一下认出来忽略掉，剩下的才当作真实操作。
   */
  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const top = element.scrollTop;
    const expectedPin = pinPendingRef.current;

    /* 每一次滚动事件都消费掉这个标记：它只对应程序刚贴底的那一下 */
    pinPendingRef.current = false;

    if (expectedPin && top === pinnedTopRef.current)
      return;

    const atBottom = element.scrollHeight - top - element.clientHeight < 24;

    /* 已经在底部（用户拖回来，或程序贴底）：恢复跟随 */
    if (atBottom) {
      pinnedTopRef.current = top;

      if (!follow)
        setFollow(true);

      return;
    }

    if (follow)
      setFollow(false);
  }

  function renderStatement(statement: LogStatement) {
    return (
      <div className="log-row" key={statement.key}>
        <span className="log-seq">{pad(statement.index, 4)}</span>
        <span className="log-time" title={stampOf(statement.time)}>{clockOf(statement.time)}</span>
        <span className={`log-badge log-badge--${statement.kind}`} title={STATEMENT_HINT[statement.kind]}>
          {STATEMENT_LABEL[statement.kind]}
        </span>
        <span className="log-sql">{sqlNodes(statement.sql, needle, statement.key)}</span>
        <span className="log-metrics">
          {statement.rows != null && <span className="log-chip log-chip--rows">{statement.rows} 行</span>}
          {statement.costMs != null && <span className="log-chip">{statement.costMs} ms</span>}
        </span>
        <button
          type="button"
          className="log-act"
          title="复制这条语句"
          aria-label="复制这条语句"
          onClick={() => onCopyRef.current(statementText(statement))}
        >
          <Icon name="copy" size={12} />
        </button>
      </div>
    );
  }

  function renderFailure(failure: LogFailure) {
    return (
      <div className="log-row is-failure" key={failure.key}>
        <span className="log-seq">✗</span>
        <span className="log-time" title={stampOf(failure.time)}>{clockOf(failure.time)}</span>
        <span className="log-badge log-badge--error">ERROR</span>
        <span className="log-message">{hits(failure.message, needle, failure.key)}</span>
        <span className="log-metrics" />
        <button
          type="button"
          className="log-act"
          title="复制这条错误"
          aria-label="复制这条错误"
          onClick={() => onCopyRef.current(`${stampOf(failure.time)} [ERROR] ${failure.message}`)}
        >
          <Icon name="copy" size={12} />
        </button>
      </div>
    );
  }

  function renderBatch(entry: VisibleBatch) {
    const batch = entry.batch;
    const rows = entry.statements.reduce((total, statement) => total + (statement.rows ?? 0), 0);
    const cost = entry.statements.reduce((total, statement) => total + (statement.costMs ?? 0), 0);
    const metrics = [
      `${entry.statements.length} 条语句`,
      rows > 0 ? `${rows} 行` : "",
      cost > 0 ? `${cost} ms` : ""
    ].filter(Boolean).join(" · ");

    return (
      <div className={`log-batch${entry.failures.length > 0 ? " is-failure" : ""}`} key={batch.key}>
        <div className="log-batch-head">
          <span className="log-batch-job">{batch.jobId != null ? `JOB ${batch.jobId}` : "JOB —"}</span>
          <span className="log-batch-time">{stampOf(batch.time)}</span>
          <span className="log-batch-meta">{metrics}</span>
          {entry.failures.length > 0 && <span className="log-batch-fail">{entry.failures.length} 处失败</span>}
        </div>

        {entry.statements.map(renderStatement)}
        {entry.failures.map(renderFailure)}
      </div>
    );
  }

  return (
    <div className={`log-console${active ? "" : " is-hidden"}`}>
      <div className="log-tools">
        <div className="log-scopes" role="group" aria-label="按类型筛选日志">
          <button
            type="button"
            className={`log-scope${scope === "all" ? " is-active" : ""}`}
            onClick={() => setScope("all")}
          >
            全部<span className="log-scope-count">{totals.all}</span>
          </button>
          <button
            type="button"
            className={`log-scope${scope === "statement" ? " is-active" : ""}`}
            onClick={() => setScope("statement")}
          >
            语句<span className="log-scope-count">{totals.statements}</span>
          </button>
          <button
            type="button"
            className={`log-scope${scope === "failure" ? " is-active" : ""}`}
            onClick={() => setScope("failure")}
          >
            错误<span className="log-scope-count">{totals.failures}</span>
          </button>
        </div>

        <span className="toolbar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={keyword}
            placeholder="搜索日志…"
            aria-label="搜索日志"
            onChange={event => setKeyword(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape")
                setKeyword("");
            }}
          />
        </span>

        <span className="tbtn-push" aria-hidden="true" />
        <span className="toolbar-text">
          {shown} 条{filtered ? ` / 共 ${totals.all} 条` : ""}
        </span>

        <button
          type="button"
          className={`tbtn${wrap ? " is-on" : ""}`}
          title="长语句自动换行"
          onClick={() => setWrap(!wrap)}
        >
          <Icon name="wrap" />换行
        </button>
        <button
          type="button"
          className={`tbtn${follow ? " is-on" : ""}`}
          title="新日志自动滚动到最新"
          onClick={() => (follow ? setFollow(false) : scrollToLatest())}
        >
          <Icon name="latest" />跟随
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={shown === 0}
          title="复制当前筛选后的日志"
          onClick={() => onCopy(exportText(entries))}
        >
          <Icon name="copy" />复制
        </button>
        <button type="button" className="tbtn" disabled={batches.length === 0} onClick={onClear}>
          <Icon name="eraser" />清空
        </button>
      </div>

      <div
        className={`log-view${wrap ? "" : " is-nowrap"}`}
        ref={viewRef}
        onScroll={handleScroll}
        /* 用户往上滚轮 = 要看历史：立刻停跟，别被随后到达的日志拽回底部 */
        onWheel={event => {
          if (event.deltaY < 0 && follow)
            setFollow(false);
        }}
      >
        {viewContent}
      </div>

      {!follow && batches.length > 0 && (
        <button type="button" className="log-jump" onClick={scrollToLatest}>
          <Icon name="latest" size={13} />最新
        </button>
      )}
    </div>
  );
}
