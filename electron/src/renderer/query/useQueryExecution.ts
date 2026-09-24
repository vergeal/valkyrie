import { useEffect, useRef } from "react";
import type * as monaco from "monaco-editor";
import { invoke, messageOf, onEvent, type ProgressEvent, type QueryResultPayload } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import type { ResultPane } from "../app/appTypes";
import { formatErrorLog, formatProgress } from "../app/format";
import { appendLog, appendLogs, errorRecord, progressRecord, type LogRecord } from "../ui/LogConsole";
import { explainStatement, isQuerySql } from "./sqlText";
import { formatSql } from "./sqlFormat";

interface UseQueryExecutionOptions {
  tabs: WorkTab[];
  updateTab: (id: string, patch: Partial<WorkTab>) => void;
  setTabs: (updater: WorkTab[] | ((previous: WorkTab[]) => WorkTab[])) => void;
  activeTab: WorkTab | null;
  editorRef: { current: monaco.editor.IStandaloneCodeEditor | null };
  resolveSessionByName: (name?: string) => SessionState | null;
  resolveSessionOfTab: (tab: WorkTab | null | undefined) => SessionState | null;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  setResultPane: (pane: ResultPane) => void;
  logLimit: number;
  /** 取标签的最新编辑器内容（内容可能还没同步进 tabs 状态） */
  resolveSql?: (tab: WorkTab) => string;
}

/**
 * 查询执行生命周期：执行 SQL（runQuery）、取消、执行计划、格式化、
 * 以及 query.progress 事件写日志 / 消息。
 */
export function useQueryExecution(options: UseQueryExecutionOptions) {
  const {
    tabs, updateTab, setTabs, activeTab, editorRef, resolveSessionByName, resolveSessionOfTab,
    setError, setStatus, setResultPane, logLimit, resolveSql
  } = options;

  const jobTabRef = useRef<Map<number, string>>(new Map());
  /* tabId → 正在执行的 job：记下发起时那条连接的会话，停止时精确取消，不受活动连接切换影响 */
  const runningJobRef = useRef<Map<string, { jobId: number; sessionId: string }>>(new Map());

  /* 日志上限会用在只注册一次的事件回调里，用 ref 取最新值 */
  const logLimitRef = useRef(logLimit);
  logLimitRef.current = logLimit;

  /*
   * 进度事件按帧合并：批量脚本会在很短时间内推来大量事件，
   * 逐个 setState 会让整棵组件树一帧内重渲染多次。这里先缓冲，rAF 里一次性落地。
   */
  const pendingProgressRef = useRef<{ line: string; record: LogRecord; cost: number | null; jobId?: number }[]>([]);
  const flushFrameRef = useRef(0);

  useEffect(() => {
    const flush = () => {
      flushFrameRef.current = 0;

      const pending = pendingProgressRef.current;

      if (pending.length === 0)
        return;

      pendingProgressRef.current = [];

      /* 日志 / 消息 / 耗时都按「事件归属的标签」分组，面板因此每个控制台各看各的 */
      const recordsByTab = new Map<string, LogRecord[]>();
      const linesByTab = new Map<string, string[]>();
      const costByTab = new Map<string, number>();

      for (const item of pending) {
        const tabId = item.jobId != null ? jobTabRef.current.get(item.jobId) : undefined;

        if (!tabId)
          continue;

        const records = recordsByTab.get(tabId) ?? [];
        records.push(item.record);
        recordsByTab.set(tabId, records);

        const lines = linesByTab.get(tabId) ?? [];
        lines.push(item.line);
        linesByTab.set(tabId, lines);

        if (item.cost != null)
          costByTab.set(tabId, item.cost);
      }

      setTabs(previous => previous.map(tab => {
        const records = recordsByTab.get(tab.id);
        const lines = linesByTab.get(tab.id);
        const cost = costByTab.get(tab.id);

        if (!records && !lines && cost == null)
          return tab;

        return {
          ...tab,
          logs: records ? appendLogs(tab.logs ?? [], records, logLimitRef.current) : tab.logs,
          messages: lines ? [...tab.messages, ...lines] : tab.messages,
          lastCost: cost != null ? cost : tab.lastCost
        };
      }));
    };

    const unsubscribe = onEvent((event: ProgressEvent) => {
      if (event.channel !== "query.progress")
        return;

      const line = formatProgress(event);
      const record = progressRecord(event);

      if (!line || !record)
        return;

      pendingProgressRef.current.push({
        line,
        record,
        cost: event.kind === "cost" && event.detail ? Number(event.detail) : null,
        jobId: event.jobId
      });

      if (!flushFrameRef.current)
        flushFrameRef.current = window.requestAnimationFrame(flush);
    });

    return () => {
      unsubscribe();

      if (flushFrameRef.current) {
        window.cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = 0;
      }

      pendingProgressRef.current = [];
    };
  }, [setTabs]);

  async function runQuery(tabId: string, sql: string) {
    if (!sql.trim())
      return;

    const jobId = Date.now();
    const tab = tabs.find(item => item.id === tabId);
    const context = tab?.kind === "query" ? tab.path : {};
    /* 用这个控制台所属连接的会话，多连接并存时不会串到别的连接上 */
    const target = resolveSessionByName(context.connection);

    if (!target) {
      setError("请先在左侧选择一个连接");
      return;
    }

    jobTabRef.current.set(jobId, tabId);
    runningJobRef.current.set(tabId, { jobId, sessionId: target.sessionId });
    setError(null);
    setStatus("执行中…");
    /* 重新执行时丢弃上一份执行计划，避免面板里显示与当前 SQL 不符的旧分析 */
    updateTab(tabId, { running: true, messages: [], lastCost: null, plan: null, planSql: undefined, planDbType: undefined });
    /* 执行期间先停留日志页，等真正有结果集再切到结果页 */
    setResultPane("log");

    try {
      const payload = await invoke<QueryResultPayload>("query.execute", {
        sessionId: target.sessionId,
        sql,
        jobId,
        catalog: context.catalog,
        schema: context.schema
      });

      const loaded = payload.rows?.length ?? 0;
      const total = payload.rowCount ?? loaded;
      /* 结果超出首个窗口时说明总数，避免用户以为只有已加载的这么多行 */
      const summary = payload.hasResultSet
        ? (total > loaded ? `返回 ${total} 行（已加载 ${loaded} 行）` : `返回 ${loaded} 行`)
        : "执行成功";

      /* 用函数式更新追加 summary：执行期间进度事件已往消息里写过内容，不能拿旧快照覆盖 */
      setTabs(previous => previous.map(item => item.id === tabId ? {
        ...item,
        result: payload,
        running: false,
        messages: [...item.messages, summary]
      } : item));
      setStatus(summary);

      if (payload.hasResultSet)
        setResultPane("grid");
    } catch (e) {
      const message = messageOf(e);

      /* 语句执行失败：写进本控制台的日志 / 消息（不弹窗、不占工作区顶部） */
      const line = formatErrorLog(message);

      setTabs(previous => previous.map(item => item.id === tabId ? {
        ...item,
        running: false,
        messages: [...item.messages, line],
        logs: appendLog(item.logs ?? [], errorRecord(message, jobId), logLimitRef.current)
      } : item));
      setResultPane("log");
      setStatus("执行失败");
    } finally {
      runningJobRef.current.delete(tabId);
      /* 事件可能还在 rAF 缓冲里，稍后再删 jobId→标签 映射，避免最后一批日志 / 消息丢失 */
      window.setTimeout(() => jobTabRef.current.delete(jobId), 1500);
    }
  }

  async function stopQuery() {
    const running = activeTab ? runningJobRef.current.get(activeTab.id) : undefined;

    if (!running)
      return;

    /* 按发起时那条连接的会话取消：期间切过连接也不影响 */
    await invoke("query.cancel", { sessionId: running.sessionId, jobId: running.jobId }).catch(() => undefined);
    setStatus("已请求取消");
  }

  async function formatActiveQuery() {
    if (!activeTab || activeTab.kind !== "query")
      return;

    const source = resolveSql ? resolveSql(activeTab) : activeTab.sql;
    /* 按这个控制台所属连接的方言格式化；连接已关就退化成通用 SQL */
    const dbType = resolveSessionOfTab(activeTab)?.product.type;

    try {
      const formatted = formatSql(source, dbType);
      const editor = editorRef.current;
      const model = editor?.getModel();

      /*
       * 用一次可撤销的编辑替换全文，而不是 setValue（setValue 会清空撤销栈，
       * 格式化后就按不回原来的写法了）。内容变更事件会顺带同步 tab.sql。
       */
      if (editor && model) {
        editor.pushUndoStop();
        editor.executeEdits("valkyrie.format", [{
          range: model.getFullModelRange(),
          text: formatted,
          forceMoveMarkers: true
        }]);
        editor.pushUndoStop();
        return;
      }

      updateTab(activeTab.id, { sql: formatted });
    } catch (e) {
      /* 格式化不是语句执行，走系统提示 */
      setError(messageOf(e));
    }
  }

  async function explainActiveQuery() {
    const target = resolveSessionOfTab(activeTab);

    if (!target || !activeTab || activeTab.kind !== "query")
      return;

    /* 有选中就分析选中的那段 SQL，否则分析整个编辑器内容 */
    const source = selectedOrFullSql().trim();

    if (!source) {
      setError("没有可分析的 SQL");
      return;
    }

    if (!isQuerySql(source)) {
      setError("仅查询语句（SELECT / SHOW / WITH 等）支持执行计划");
      return;
    }

    const dbType = target.product.type;

    setResultPane("plan");
    setStatus("解析执行计划…");

    const jobId = Date.now();
    const tabId = activeTab.id;

    /* 让 EXPLAIN 的进度事件也归到这个控制台，而不是落到公共日志里 */
    jobTabRef.current.set(jobId, tabId);

    try {
      const payload = await invoke<QueryResultPayload>("query.execute", {
        sessionId: target.sessionId,
        sql: explainStatement(source, dbType),
        jobId
      });

      updateTab(tabId, { plan: payload, planSql: source, planDbType: dbType });
      setStatus("执行计划已生成");
    } catch (e) {
      /* 执行计划解析失败：写进本控制台的日志面板 */
      const message = messageOf(e);

      setTabs(previous => previous.map(item => item.id === tabId ? {
        ...item,
        logs: appendLog(item.logs ?? [], errorRecord(message, jobId), logLimitRef.current)
      } : item));
      setResultPane("log");
      setStatus("执行计划解析失败");
    } finally {
      window.setTimeout(() => jobTabRef.current.delete(jobId), 1500);
    }
  }

  /** 编辑器有选区就取选区，否则取整篇内容；编辑器缺失时退回标签里保存的 SQL */
  function selectedOrFullSql(): string {
    const editor = editorRef.current;

    if (!editor)
      return activeTab?.kind === "query" ? (resolveSql ? resolveSql(activeTab) : activeTab.sql) : "";

    const selection = editor.getSelection();
    const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) ?? "" : "";

    return selected.trim() ? selected : editor.getValue();
  }

  async function runSelectionOrAll() {
    const editor = editorRef.current;

    if (!editor || !activeTab || activeTab.kind !== "query")
      return;

    const selection = editor.getSelection();
    const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) ?? "" : "";

    /* 没有选区就跑全文：直接用编辑器当前内容，避免读到还没同步进状态的旧值 */
    await runQuery(activeTab.id, selected.trim() ? selected : editor.getValue());
  }

  return { runQuery, stopQuery, formatActiveQuery, explainActiveQuery, runSelectionOrAll };}
