import { invoke, messageOf, type SchemaNode, type TableColumn, type TableIndex } from "../api";
import type { DesignTab } from "../app/appTypes";
import type { DesignColumn, DesignIndex } from "../ui/TableDesign";
import { nextTabId } from "../tabs/tabHelpers";
import { describeDesignChanges, tableParams } from "./tableHelpers";
import type { TableContext } from "./tableActions";

/**
 * 表设计页：打开设计页、读取结构、保存结构差异、执行 DDL、复制建表语句。
 */
export function useTableDesign(ctx: TableContext) {
  const {
    tabs, setTabs, setActiveTabId, updateTab, sessionOfNode, connectionOfNode,
    askConfirm, withBusy, setPending, setError, setStatus, flash, refreshObjectList, copyText
  } = ctx;

  function openTableDesign(node: SchemaNode) {
    if (!node.table)
      return;

    const existing = tabs.find(tab => tab.kind === "design" && tab.node.table?.name === node.table?.name);

    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const tab: DesignTab = {
      id: nextTabId(),
      kind: "design",
      title: `设计: ${node.label}`,
      running: false,
      messages: [],
      connection: connectionOfNode(node),
      node,
      columns: [],
      indexes: [],
      ddl: "",
      loading: true
    };

    setTabs(previous => [...previous, tab]);
    setActiveTabId(tab.id);
    void loadDesign(tab.id, node);
  }

  async function loadDesign(tabId: string, node: SchemaNode) {
    const tab = tabs.find(item => item.id === tabId);
    const target = sessionOfNode(node, tab);

    if (!target)
      return;

    const params = tableParams(target.sessionId, node);

    try {
      const [columns, indexes, ddl] = await Promise.all([
        invoke<{ columns: TableColumn[] }>("table.columns", params),
        invoke<{ indexes: TableIndex[] }>("table.indexes", params),
        invoke<{ ddl: string }>("table.ddl", params)
      ]);

      updateTab(tabId, {
        columns: columns.columns,
        indexes: indexes.indexes,
        ddl: ddl.ddl,
        loading: false
      });
    } catch (e) {
      setError(messageOf(e));
      updateTab(tabId, { loading: false });
    }
  }

  async function saveTableDesign(
    tabId: string, node: SchemaNode, columns: DesignColumn[], indexes: DesignIndex[]
  ) {
    const tab = tabs.find(item => item.id === tabId);
    const target = sessionOfNode(node, tab);

    if (!target)
      return;

    const changes = describeDesignChanges(tab?.kind === "design" ? tab : undefined, columns, indexes);
    const confirmed = await askConfirm(
      `将要对表 ${node.label} 执行以下结构修改：\n\n`
      + `${changes.length > 0 ? changes.join("\n") : "（没有检测到结构变化）"}\n\n`
      + "这些改动会直接写进数据库，无法撤销，确定执行吗？",
      "保存表设计",
      true
    );

    if (!confirmed)
      return;

    setPending("saveDesign");

    try {
      const payload = await withBusy(() => invoke<{
        columns: TableColumn[];
        indexes: TableIndex[];
        ddl: string;
      }>("table.design", {
        ...tableParams(target.sessionId, node),
        columns,
        indexes
      }));

      /* 数据层回读的结构直接落进标签，页面不用再等一次往返 */
      updateTab(tabId, {
        columns: payload.columns ?? [],
        indexes: payload.indexes ?? [],
        ddl: payload.ddl ?? "",
        loading: false,
        title: `设计: ${node.label}`
      });

      await refreshObjectList(node);
      setStatus("表结构已保存");
      flash("表结构已保存");
    } catch (e) {
      setError(messageOf(e));
      /* 失败时把结构拉回库里的真实状态，别让页面停在一份没生效的改动上 */
      await loadDesign(tabId, node);
    } finally {
      setPending(null);
    }
  }

  /** 执行表设计页里编辑过的 DDL（先确认，再重新读取结构与表列表） */
  async function applyTableDdl(tabId: string, node: SchemaNode, ddl: string) {
    const tab = tabs.find(item => item.id === tabId);
    const target = sessionOfNode(node, tab);

    if (!target)
      return;

    const confirmed = await askConfirm(
      `确定执行下面这段 DDL？它会直接改动数据库里的对象，无法撤销。\n\n${ddl.length > 400 ? `${ddl.slice(0, 400)}…` : ddl}`,
      "执行 DDL",
      true
    );

    if (!confirmed)
      return;

    try {
      await withBusy(() => invoke("query.execute", {
        sessionId: target.sessionId,
        sql: ddl,
        jobId: Date.now(),
        catalog: node.catalog,
        schema: node.schema
      }));

      await loadDesign(tabId, node);
      await refreshObjectList(node);
      setStatus("DDL 已执行");
      flash("DDL 已执行");
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function copyDdl(node: SchemaNode) {
    const target = sessionOfNode(node);

    if (!target)
      return;

    try {
      const payload = await invoke<{ ddl: string }>("table.ddl", tableParams(target.sessionId, node));
      await copyText(payload.ddl);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return { openTableDesign, loadDesign, saveTableDesign, applyTableDdl, copyDdl };
}
