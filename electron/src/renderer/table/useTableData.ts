import { invoke, messageOf, type QueryResultPayload, type SchemaNode } from "../api";
import type { DataTab } from "../app/appTypes";
import { nextTabId } from "../tabs/tabHelpers";
import { tableParams } from "./tableHelpers";
import type { TableContext } from "./tableActions";

/**
 * 表数据页：打开数据页、分页读取、以及「清空表 / 删除表」这类基于表节点的操作。
 */
export function useTableData(ctx: TableContext) {
  const {
    settings, tabs, setTabs, setActiveTabId, updateTab, sessionOfNode, connectionOfNode,
    askConfirm, setPending, setError, setStatus, flash, refreshObjectList, activeNode, session,
    setTableSelection
  } = ctx;

  function openTableData(node: SchemaNode) {
    if (!node.table)
      return;

    /* 同名表可能出现在不同库 / 模式下，必须带上上下文一起比较 */
    const existing = tabs.find(tab =>
      tab.kind === "data"
      && tab.node.table?.name === node.table?.name
      && tab.node.catalog === node.catalog
      && tab.node.schema === node.schema);

    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const tab: DataTab = {
      id: nextTabId(),
      kind: "data",
      title: node.label,
      running: false,
      messages: [],
      connection: connectionOfNode(node),
      node,
      result: null,
      dirtyRows: [],
      page: 0,
      pageSize: settings.pageSize
    };

    setTabs(previous => [...previous, tab]);
    setActiveTabId(tab.id);
    void loadPage(tab.id, node, 0, settings.pageSize);
  }

  async function loadPage(tabId: string, node: SchemaNode, page: number, pageSize: number) {
    const tab = tabs.find(item => item.id === tabId);
    const target = sessionOfNode(node, tab);

    if (!target)
      return;

    setPending("loadPage");

    try {
      const payload = await invoke<QueryResultPayload>("table.page", {
        ...tableParams(target.sessionId, node),
        offset: page * pageSize,
        size: pageSize
      });

      updateTab(tabId, { result: payload, page, pageSize, running: false });
      setStatus(`读取 ${node.label} 第 ${page + 1} 页`);
    } catch (e) {
      setError(messageOf(e));
      updateTab(tabId, { running: false });
    } finally {
      setPending(null);
    }
  }

  /* 执行一条语句（用于清空表 / 删除表这类对象操作） */
  async function executeStatement(sql: string, node?: SchemaNode) {
    const target = sessionOfNode(node ?? activeNode);

    if (!target)
      return;

    await invoke<QueryResultPayload>("query.execute", {
      sessionId: target.sessionId,
      sql,
      jobId: Date.now(),
      catalog: node?.catalog ?? activeNode?.catalog,
      schema: node?.schema ?? activeNode?.schema
    });
  }

  async function clearTable(node: SchemaNode) {
    const confirmed = await askConfirm(`确定清空表 ${node.label} 的全部数据？此操作不可恢复！`, "清空表", true);

    if (!confirmed)
      return;

    const sql = session?.product.type === "sqlite"
      ? `DELETE FROM ${node.label}`
      : `TRUNCATE TABLE ${node.label}`;

    try {
      await executeStatement(sql, node);
      await refreshObjectList(node);
      setStatus(`已清空 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function dropTable(node: SchemaNode) {
    const confirmed = await askConfirm(`确定删除表 ${node.label}？此操作不可恢复！`, "删除表", true);

    if (!confirmed)
      return;

    try {
      await executeStatement(`DROP TABLE ${node.label}`, node);
      await refreshObjectList(node);
      setStatus(`已删除 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** 「对象」页多选后批量删除表（一次确认，逐个执行） */
  async function dropTables(nodes: SchemaNode[]) {
    if (nodes.length === 0)
      return;

    const confirmed = await askConfirm(`确定删除选中的 ${nodes.length} 张表？此操作不可恢复！`, "删除表", true);

    if (!confirmed)
      return;

    try {
      for (const node of nodes) {
        await executeStatement(`DROP TABLE ${node.label}`, node);
        await refreshObjectList(node);
      }

      setStatus(`已删除 ${nodes.length} 张表`);
      flash(`已删除 ${nodes.length} 张表`);
      setTableSelection([]);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return { openTableData, loadPage, executeStatement, clearTable, dropTable, dropTables };
}
