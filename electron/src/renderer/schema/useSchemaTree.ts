import { useEffect, useMemo, useState } from "react";
import { invoke, messageOf, type TableColumn, type TableIndex, type SavedConnection, type SchemaNode } from "../api";
import type { ObjectTab, SessionState, WorkTab } from "../app/appTypes";
import { affectsTabOnNodeClose, connectionOfTab } from "../tabs/tabHelpers";
import { connectionOfNode as connectionOfNodeHelper, parentTreeNode as parentTreeNodeHelper, schemaRank } from "./schemaHelpers";
import { sessionByName } from "../connection/connectionHelpers";
import { tableParams } from "../table/tableHelpers";

export interface SchemaTreeDeps {
  expanded: Set<string>;
  setExpanded: (updater: (previous: Set<string>) => Set<string>) => void;
  loadingNodes: Set<string>;
  setLoadingNodes: (updater: (previous: Set<string>) => Set<string>) => void;
  activeNode: SchemaNode | null;
  session: SessionState | null;
  openSessions: Record<string, SessionState>;
  connections: SavedConnection[];
  rootsByConnection: Record<string, SchemaNode[]>;
  tabs: WorkTab[];
  setTabs: (updater: WorkTab[] | ((previous: WorkTab[]) => WorkTab[])) => void;
  activeTabId: string;
  setActiveTabId: (updater: string | ((previous: string) => string)) => void;
  openConnection: (connection: SavedConnection, options?: { focusPage?: boolean }) => Promise<boolean>;
  refreshConnectionRoots: (name: string) => Promise<void>;
  showTableList: (node: SchemaNode, options?: { force?: boolean; quiet?: boolean; activate?: boolean; session?: SessionState | null }) => Promise<void>;
  refreshTableList: (tabId: string, container: SchemaNode) => Promise<void>;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  flash: (text: string) => void;
}

/**
 * Schema 域：对象树节点缓存、children 载入、展开 / 收起、刷新，
 * 以及表 / 模式 / 数据库到「表容器」的定位；结构信息（列 / 索引）也在这里读取。
 */
export function useSchemaTree(deps: SchemaTreeDeps) {
  const {
    expanded, setExpanded, loadingNodes, setLoadingNodes, activeNode, session, openSessions,
    connections, rootsByConnection, tabs, setTabs, activeTabId, setActiveTabId,
    openConnection, refreshConnectionRoots, showTableList, refreshTableList, setError, setStatus, flash
  } = deps;

  const [childrenMap, setChildrenMap] = useState<Record<string, SchemaNode[]>>({});
  const [infoColumns, setInfoColumns] = useState<TableColumn[]>([]);
  const [infoIndexes, setInfoIndexes] = useState<TableIndex[]>([]);

  const treeRoot = useMemo<SchemaNode>(() => ({
    id: "conn-root",
    label: "我的连接",
    kind: "ROOT",
    hasChildren: true
  }), []);

  const treeChildren = useMemo(() => {
    const merged: Record<string, SchemaNode[]> = {
      ...childrenMap,
      "conn-root": connections.map(connection => ({
        id: `conn:${connection.name}`,
        label: connection.name,
        kind: "CONNECTION" as const,
        hasChildren: true,
        /* 多连接并存：凡是开着会话的连接都算已连接 */
        connected: Boolean(openSessions[connection.name]),
        dbType: connection.type
      }))
    };

    /* 每个已打开连接各自的数据库列表都挂上去 */
    for (const [name, nodes] of Object.entries(rootsByConnection))
      merged[`conn:${name}`] = nodes;

    return merged;
  }, [childrenMap, connections, rootsByConnection, openSessions]);

  function parentTreeNode(id: string): SchemaNode | null {
    return parentTreeNodeHelper(treeRoot, treeChildren, id);
  }

  function connectionOfNode(node: SchemaNode | null | undefined): string | undefined {
    return connectionOfNodeHelper(node, treeRoot, treeChildren);
  }

  function sessionOfNode(node: SchemaNode | null | undefined, tab?: WorkTab | null): SessionState | null {
    return sessionByName(connectionOfNode(node) ?? connectionOfTab(tab), openSessions, session);
  }

  async function loadChildren(sessionId: string, node: SchemaNode, force = false): Promise<SchemaNode[]> {
    /* 已经加载过就直接复用：数据层每次返回的节点 id 都是新的，
       重复加载会让已展开的子节点对不上 id 而消失 */
    const cached = childrenMap[node.id];

    if (cached && !force)
      return cached;

    setLoadingNodes(previous => new Set(previous).add(node.id));

    try {
      const payload = await invoke<{ nodes: SchemaNode[] }>("schema.children", {
        sessionId,
        nodeId: node.id
      });

      /* 把 catalog / schema 继承给子节点，便于后续分页、取表结构 */
      const children = payload.nodes.map(child => ({
        ...child,
        catalog: child.catalog ?? node.catalog ?? (node.kind === "CATALOG" ? node.label : undefined),
        schema: child.schema ?? node.schema ?? (node.kind === "SCHEMA" ? node.label : undefined)
      }));

      setChildrenMap(previous => ({ ...previous, [node.id]: children }));

      return children;
    } catch (e) {
      setError(messageOf(e));
      return [];
    } finally {
      setLoadingNodes(previous => {
        const next = new Set(previous);
        next.delete(node.id);
        return next;
      });
    }
  }

  async function toggleNode(node: SchemaNode) {
    if (node.kind === "ROOT" || (node.kind === "CONNECTION" && node.connected)) {
      setExpanded(previous => {
        const next = new Set(previous);

        if (next.has(node.id))
          next.delete(node.id);
        else
          next.add(node.id);

        return next;
      });
      return;
    }

    /* 未连接的连接节点：点击即建立连接 */
    if (node.kind === "CONNECTION") {
      const connection = connections.find(item => item.name === node.label);

      if (!connection)
        return;

      await openConnection(connection);
      setExpanded(previous => new Set(previous).add(node.id));
      return;
    }

    if (!node.hasChildren || !session)
      return;

    if (expanded.has(node.id)) {
      /* 收起节点：连带关闭它下面打开的数据页 / 表设计页 */
      closeTabsUnder(node);

      setExpanded(previous => {
        const next = new Set(previous);
        next.delete(node.id);
        return next;
      });
      return;
    }

    setExpanded(previous => new Set(previous).add(node.id));

    if (childrenMap[node.id] || loadingNodes.has(node.id))
      return;

    await loadChildren(sessionOfNode(node)?.sessionId ?? "", node);
  }

  /**
   * 关闭某个树节点下打开的标签页：
   * 连接 → 它的全部数据/设计页；数据库 → 该库下的；模式 → 该模式下的；表容器/表 → 对应的表。
   * 查询控制台与常驻的「对象」页不受影响。
   */
  function closeTabsUnder(node: SchemaNode) {
    const next = tabs.filter(tab => !affectsTabOnNodeClose(tab, node));

    if (next.length === tabs.length)
      return;

    setTabs(next);

    if (!next.some(tab => tab.id === activeTabId))
      setActiveTabId(next[next.length - 1]?.id ?? "");
  }

  async function loadTableNodes(container: SchemaNode, force = true, sessionId?: string): Promise<SchemaNode[]> {
    const id = sessionId ?? sessionOfNode(container)?.sessionId;

    if (!id)
      return [];

    const children = await loadChildren(id, container, force);

    return children.filter(node => node.kind === "TABLE" && !node.hasChildren);
  }

  /**
   * 找到某个节点下的「表容器」：
   * - 表容器 → 自己；数据表 → 它所在的容器；
   * - 库下面直接挂着表容器的（MySQL 这类）→ 用它；
   * - 库下面还隔着模式的（PostgreSQL）→ 优先 public，其次是第一个非系统模式。
   */
  async function firstTableContainer(sessionId: string, node: SchemaNode): Promise<SchemaNode | null> {
    if (node.kind === "TABLE" && node.hasChildren)
      return node;

    if (node.kind === "TABLE") {
      const parent = parentTreeNode(node.id);

      return parent && parent.kind === "TABLE" && parent.hasChildren ? parent : null;
    }

    if (node.kind !== "CATALOG" && node.kind !== "SCHEMA")
      return null;

    const children = await loadChildren(sessionId, node);
    const direct = children.find(child => child.kind === "TABLE" && child.hasChildren);

    if (direct)
      return direct;

    const schemas = children
      .filter(child => child.kind === "SCHEMA")
      .sort((a, b) => schemaRank(a.label) - schemaRank(b.label));

    for (const schema of schemas) {
      const container = (await loadChildren(sessionId, schema))
        .find(child => child.kind === "TABLE" && child.hasChildren);

      if (container)
        return container;
    }

    return null;
  }

  async function refreshObjectList(node: SchemaNode) {
    /* 连接节点上的「刷新对象」＝重新读它的库 / 模式列表 */
    if (node.kind === "CONNECTION") {
      await refreshConnectionRoots(node.label);
      return;
    }

    const active = sessionOfNode(node);

    if (!active)
      return;

    const page = tabs.find((tab): tab is ObjectTab => tab.kind === "objects");

    /* 对象页眼下属于别的连接：先把它交给这个节点所属的连接，免得按别的连接去读表 */
    if (page && page.connection !== active.name) {
      await showTableList(node, { force: true, quiet: true, session: active, activate: false });
      return;
    }

    try {
      const candidates = await containerCandidates(active.sessionId, node);

      if (page) {
        /*
         * 能拿到同一批对象的「新」容器节点就用它（节点 id 每次加载都会变），
         * 拿不到就直接用页面自己绑定的容器 —— 无论如何都走页面刷新这条路。
         */
        const fresh = candidates.find(item =>
          item.catalog === page.node?.catalog && item.schema === page.node?.schema);
        const container = fresh ?? page.node;

        if (!container) {
          setError("对象列表还没绑定数据库，请重新打开一次");
          return;
        }

        await refreshTableList(page.id, container);
        return;
      }

      if (candidates.length === 0) {
        setStatus(`已刷新 ${node.label}`);
        flash(`已刷新 ${node.label}`);
        return;
      }

      await loadTableNodes(candidates[0]);
      setStatus(`已刷新 ${node.label}`);
      flash(`已刷新 ${node.label}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /**
   * 一个节点可能对应的「表容器」新节点：
   * 表容器 → 自己；表 → 父容器；库 / 模式 → 底下的容器（库还要再往下走一层模式）。
   */
  async function containerCandidates(sessionId: string, node: SchemaNode): Promise<SchemaNode[]> {
    if (node.kind === "TABLE" && node.hasChildren)
      return [node];

    if (node.kind === "TABLE") {
      const parent = parentTreeNode(node.id);

      return parent && parent.kind === "TABLE" && parent.hasChildren ? [parent] : [];
    }

    if (node.kind !== "CATALOG" && node.kind !== "SCHEMA")
      return [];

    const children = await loadChildren(sessionId, node, true);
    const direct = children.find(child => child.kind === "TABLE" && child.hasChildren);
    const found = direct ? [direct] : [];

    for (const schema of children.filter(child => child.kind === "SCHEMA")) {
      const grand = await loadChildren(sessionId, schema, true);
      const container = grand.find(child => child.kind === "TABLE" && child.hasChildren);

      if (container)
        found.push(container);
    }

    return found;
  }

  /* 选中表对象时加载结构与索引 */
  useEffect(() => {
    let cancelled = false;

    if (!session || !activeNode || activeNode.kind !== "TABLE" || !activeNode.table) {
      setInfoColumns([]);
      setInfoIndexes([]);
      return;
    }

    const params = tableParams(sessionOfNode(activeNode)?.sessionId ?? session.sessionId, activeNode);

    void Promise.all([
      invoke<{ columns: TableColumn[] }>("table.columns", params),
      invoke<{ indexes: TableIndex[] }>("table.indexes", params)
    ]).then(([columns, indexes]) => {
      if (cancelled)
        return;

      setInfoColumns(columns.columns);
      setInfoIndexes(indexes.indexes);
    }).catch(() => {
      if (!cancelled) {
        setInfoColumns([]);
        setInfoIndexes([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeNode, session]);

  return {
    treeRoot, treeChildren,
    loadChildren, toggleNode, closeTabsUnder, loadTableNodes,
    firstTableContainer, refreshObjectList, containerCandidates,
    parentTreeNode, connectionOfNode, sessionOfNode,
    infoColumns, setInfoColumns, infoIndexes, setInfoIndexes
  };
}
