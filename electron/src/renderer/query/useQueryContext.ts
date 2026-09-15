import { useEffect, useRef, useState } from "react";
import { invoke, type SavedConnection, type SchemaNode } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import type { SuggestionContext } from "../editor/completionProvider";
import { connectionOfTab } from "../tabs/tabHelpers";
import { selectionContext as selectionContextHelper } from "../schema/schemaHelpers";

export interface QueryContextDeps {
  session: SessionState | null;
  connections: SavedConnection[];
  roots: SchemaNode[];
  tabs: WorkTab[];
  setTabs: (updater: WorkTab[] | ((previous: WorkTab[]) => WorkTab[])) => void;
  activeTab: WorkTab | null;
  activeNode: SchemaNode | null;
  loadChildren: (sessionId: string, node: SchemaNode, force?: boolean) => Promise<SchemaNode[]>;
  treeRoot: SchemaNode;
  treeChildren: Record<string, SchemaNode[]>;
  lastSessionRef: { current: { name?: string; type: string } };
}

/**
 * 查询执行上下文：数据库 / 模式 / 表候选，SQL 补全上下文（含断开后的快照降级），
 * 以及进入查询页时的补全引擎预热。这些状态由本 Hook 持有。
 */
export function useQueryContext(deps: QueryContextDeps) {
  const {
    session, connections, roots, tabs, setTabs, activeTab, activeNode,
    loadChildren, treeRoot, treeChildren, lastSessionRef
  } = deps;

  const [catalogOptions, setCatalogOptions] = useState<SchemaNode[]>([]);
  const [schemaOptions, setSchemaOptions] = useState<SchemaNode[]>([]);
  /* 当前数据库/模式下的全部表，供工具栏「表」下拉与智能提示使用 */
  const [tableNodes, setTableNodes] = useState<SchemaNode[]>([]);

  /* Monaco 补全 Provider 每次实时读取的上下文 */
  const suggestionContextRef = useRef<SuggestionContext>({});

  const activeCatalog = activeTab?.kind === "query" ? activeTab.path.catalog : undefined;
  const activeSchema = activeTab?.kind === "query" ? activeTab.path.schema : undefined;

  /**
   * 当前查询控制台属于哪个连接：优先用标签自己记的（断开后仍在），
   * 再看它绑定的脚本，最后退回最近一次连接过的连接名。
   */
  function consoleConnection(): string | undefined {
    if (activeTab?.kind !== "query")
      return lastSessionRef.current.name;

    return activeTab.path.connection ?? activeTab.script?.connection ?? lastSessionRef.current.name;
  }

  /** 没有活动会话时补全用的数据库类型：同上看连接，再退回最近连接过的类型 */
  function suggestionType(): string {
    const name = consoleConnection();
    const found = name ? connections.find(item => item.name === name)?.type : undefined;

    return found ?? lastSessionRef.current.type;
  }

  /*
   * 补全上下文：
   * - 有会话时带 sessionId，数据层给「关键字 + 本库表名 + 引用表的字段」，
   *   同时按连接名留一份元数据快照；
   * - 连接已关闭时改带连接名，数据层用那份快照继续提示表名 / 字段（内容是断开前的），
   *   快照也没有（比如从没在这个连接上敲过字）才退化成该方言的关键字。
   */
  suggestionContextRef.current = (() => {
    /*
     * 会话要和标签同属一条连接才能把 sessionId 递过去：
     * 拿 A 的会话配 B 的库去问元数据，表名 / 字段提示会落空。
     * 不是同一条连接时退化成「只给连接名」，数据层用断开时留下的快照照样能提示。
     */
    const tabConnection = activeTab ? connectionOfTab(activeTab) : undefined;
    const sameConnection = Boolean(session && (!tabConnection || tabConnection === session.name));
    /*
     * 库要取会话里真实存在的那个：脚本按目录存放，目录名可能是 "default"
     * 这类建库时并不存在的名字，直接拿去问元数据就只有关键字、没有表与字段。
     */
    const catalog = activeCatalog && catalogOptions.some(node => node.label === activeCatalog)
      ? activeCatalog
      : catalogOptions[0]?.label;

    return {
      sessionId: sameConnection ? session?.sessionId : undefined,
      connection: sameConnection ? session?.name : (tabConnection ?? session?.name ?? lastSessionRef.current.name),
      catalog: catalog ?? activeCatalog,
      schema: activeSchema,
      type: sameConnection ? undefined : suggestionType()
    };
  })();

  /*
   * 进入查询页（或切库 / 切模式）时预热该上下文的补全引擎：
   * 数据层顺手留下元数据快照，之后断开连接仍然能提示表名与字段。
   */
  const warmPath = activeTab?.kind === "query" ? activeTab.path : undefined;

  useEffect(() => {
    if (!session || !warmPath)
      return;

    void invoke("sql.warmSuggest", {
      sessionId: session.sessionId,
      catalog: warmPath.catalog ?? catalogOptions[0]?.label,
      schema: warmPath.schema
    }).catch(() => undefined);
  }, [session?.sessionId, activeTab?.id, warmPath?.catalog, warmPath?.schema, catalogOptions]);

  /* 连接后把根节点作为「数据库」候选，并给查询页一个默认上下文 */
  useEffect(() => {
    setCatalogOptions(roots);

    if (roots.length === 0)
      return;

    setTabs(previous => previous.map(tab =>
      tab.kind === "query" && !tab.path.catalog
        ? { ...tab, path: { ...tab.path, catalog: roots[0].label } }
        : tab));
  }, [roots, setTabs]);

  /* 切换数据库：加载模式列表与表列表 */
  useEffect(() => {
    if (!session || !activeCatalog) {
      setSchemaOptions([]);
      setTableNodes([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      const catalogNode = roots.find(node => node.label === activeCatalog);

      if (!catalogNode)
        return;

      const children = await loadChildren(session.sessionId, catalogNode);

      if (cancelled)
        return;

      const schemas = children.filter(node => node.kind === "SCHEMA");
      setSchemaOptions(schemas);

      /* MySQL 这类没有模式层级：表直接挂在数据库下的「数据表」容器里 */
      const container = children.find(node => node.kind === "TABLE" && node.hasChildren);

      if (schemas.length === 0 && container) {
        const tables = await loadChildren(session.sessionId, container);

        if (!cancelled)
          setTableNodes(tables.filter(node => node.kind === "TABLE" && !node.hasChildren));
      } else if (!cancelled) {
        setTableNodes([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, activeCatalog, roots, loadChildren]);

  /* 切换模式：加载该模式下的表 */
  useEffect(() => {
    /* 没有模式层级时由上面那个 effect 负责表列表 */
    if (!session || !activeSchema)
      return;

    let cancelled = false;

    void (async () => {
      const schemaNode = schemaOptions.find(node => node.label === activeSchema);

      if (!schemaNode)
        return;

      const children = await loadChildren(session.sessionId, schemaNode);

      if (cancelled)
        return;

      const container = children.find(node => node.kind === "TABLE" && node.hasChildren);

      if (!container) {
        setTableNodes([]);
        return;
      }

      const tables = await loadChildren(session.sessionId, container);

      if (!cancelled)
        setTableNodes(tables.filter(node => node.kind === "TABLE" && !node.hasChildren));
    })();

    return () => {
      cancelled = true;
    };
  }, [session, activeSchema, schemaOptions, loadChildren]);

  /** 选中节点 → 执行上下文：连接名 + 数据库 + 模式 */
  function selectionContext(): { connection?: string; catalog?: string; schema?: string } {
    return selectionContextHelper(activeNode, catalogOptions, treeRoot, treeChildren);
  }

  return {
    catalogOptions, setCatalogOptions,
    schemaOptions, setSchemaOptions, tableNodes, setTableNodes,
    suggestionContextRef, selectionContext
  };
}
