import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";
import { invoke, messageOf, onEvent, type ProgressEvent, type QueryResultPayload } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import type { ResultPane } from "../app/appTypes";
import { formatErrorLog, formatProgress } from "../app/format";
import { appendLog, errorRecord, progressRecord, type LogRecord } from "../ui/LogConsole";

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
}

/**
 * 查询执行生命周期：执行 SQL（runQuery）、取消、执行计划、格式化、
 * 以及 query.progress 事件写日志 / 消息。
 */
export function useQueryExecution(options: UseQueryExecutionOptions) {
  const {
    tabs, updateTab, setTabs, activeTab, editorRef, resolveSessionByName, resolveSessionOfTab,
    setError, setStatus, setResultPane, logLimit
  } = options;

  const jobTabRef = useRef<Map<number, string>>(new Map());
  const runningJobRef = useRef<Map<string, number>>(new Map());
  /* 语句执行报错写进日志面板，不再占用工作区顶部 */
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [lastCost, setLastCost] = useState<number | null>(null);

  /* 日志上限会用在只注册一次的事件回调里，用 ref 取最新值 */
  const logLimitRef = useRef(logLimit);
  logLimitRef.current = logLimit;

  useEffect(() => {
    return onEvent((event: ProgressEvent) => {
      if (event.channel !== "query.progress")
        return;

      const line = formatProgress(event);
      const record = progressRecord(event);

      if (!line || !record)
        return;

      if (event.kind === "cost" && event.detail)
        setLastCost(Number(event.detail));

      setLogs(previous => appendLog(previous, record, logLimitRef.current));

      const tabId = event.jobId != null ? jobTabRef.current.get(event.jobId) : undefined;

      if (tabId)
        setTabs(previous => previous.map(tab => tab.id === tabId ? { ...tab, messages: [...tab.messages, line] } : tab));
    });
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
    runningJobRef.current.set(tabId, jobId);
    setError(null);
    setStatus("执行中…");
    setLastCost(null);
    updateTab(tabId, { running: true, messages: [] });
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

      const rows = payload.rows?.length ?? 0;
      const summary = payload.hasResultSet ? `返回 ${rows} 行` : "执行成功";

      updateTab(tabId, {
        result: payload,
        running: false,
        messages: [...(tabs.find(tab => tab.id === tabId)?.messages ?? []), summary]
      });
      setStatus(summary);

      if (payload.hasResultSet)
        setResultPane("grid");
    } catch (e) {
      const message = messageOf(e);

      /* 语句执行失败：写进日志面板（不弹窗、不占工作区顶部） */
      const line = formatErrorLog(message);

      setLogs(previous => appendLog(previous, errorRecord(message, jobId), logLimitRef.current));
      setResultPane("log");
      setStatus("执行失败");
      updateTab(tabId, { running: false, messages: [line] });
    } finally {
      jobTabRef.current.delete(jobId);
      runningJobRef.current.delete(tabId);
    }
  }

  async function stopQuery() {
    const target = resolveSessionOfTab(activeTab);

    if (!target || !activeTab || !activeTab.running)
      return;

    const jobId = runningJobRef.current.get(activeTab.id);

    if (jobId == null)
      return;

    await invoke("query.cancel", { sessionId: target.sessionId, jobId }).catch(() => undefined);
    setStatus("已请求取消");
  }

  async function formatActiveQuery() {
    if (!activeTab || activeTab.kind !== "query")
      return;

    try {
      const payload = await invoke<{ sql: string }>("sql.format", { sql: activeTab.sql });
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
          text: payload.sql,
          forceMoveMarkers: true
        }]);
        editor.pushUndoStop();
        return;
      }

      updateTab(activeTab.id, { sql: payload.sql });
    } catch (e) {
      /* 格式化不是语句执行，走系统提示 */
      setError(messageOf(e));
    }
  }

  async function explainActiveQuery() {
    const target = resolveSessionOfTab(activeTab);

    if (!target || !activeTab || activeTab.kind !== "query")
      return;

    setResultPane("plan");
    setStatus("解析执行计划…");

    const jobId = Date.now();

    try {
      const payload = await invoke<QueryResultPayload>("query.execute", {
        sessionId: target.sessionId,
        sql: `EXPLAIN ${activeTab.sql.replace(/;\s*$/, "")}`,
        jobId
      });

      updateTab(activeTab.id, { plan: payload });
      setStatus("执行计划已生成");
    } catch (e) {
      /* 执行计划解析失败：同样写进日志面板 */
      const message = messageOf(e);

      setLogs(previous => appendLog(previous, errorRecord(message, jobId), logLimitRef.current));
      setResultPane("log");
      setStatus("执行计划解析失败");
    }
  }

  async function runSelectionOrAll() {
    const editor = editorRef.current;

    if (!editor || !activeTab || activeTab.kind !== "query")
      return;

    const selection = editor.getSelection();
    const selected = selection && !selection.isEmpty() ? editor.getModel()?.getValueInRange(selection) ?? "" : "";

    await runQuery(activeTab.id, selected.trim() ? selected : activeTab.sql);
  }

  return { runQuery, stopQuery, formatActiveQuery, explainActiveQuery, runSelectionOrAll, logs, setLogs, lastCost, setLastCost };}
