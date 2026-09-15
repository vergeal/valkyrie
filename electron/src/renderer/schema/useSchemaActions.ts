import type { SchemaNode } from "../api";
import type { SessionState } from "../app/appTypes";

export interface SchemaActionsDeps {
  setActiveNode: (node: SchemaNode | null) => void;
  setExpanded: (updater: (previous: Set<string>) => Set<string>) => void;
  openSessions: Record<string, SessionState>;
  session: SessionState | null;
  setSession: (session: SessionState | null) => void;
  rootsByConnection: Record<string, SchemaNode[]>;
  setRoots: (nodes: SchemaNode[]) => void;
  setCatalogOptions: (nodes: SchemaNode[]) => void;
  setSchemaOptions: (nodes: SchemaNode[]) => void;
  setTableNodes: (nodes: SchemaNode[]) => void;
  connectionOfNode: (node: SchemaNode | null | undefined) => string | undefined;
  sessionOfNode: (node: SchemaNode | null | undefined) => SessionState | null;
  parentTreeNode: (id: string) => SchemaNode | null;
  loadChildren: (sessionId: string, node: SchemaNode, force?: boolean) => Promise<SchemaNode[]>;
  toggleNode: (node: SchemaNode) => void;
  focusObjectPage: (name: string, context?: { session?: SessionState | null; roots?: SchemaNode[] | null }) => void;
  showScriptList: (options?: { force?: boolean; highlightName?: string; source?: SchemaNode; session?: SessionState | null; activate?: boolean }) => void;
  showTableList: (node: SchemaNode, options?: { force?: boolean; quiet?: boolean; activate?: boolean; session?: SessionState | null }) => void;
  openScript: (node: SchemaNode) => void;
  openScriptList: () => void;
  openTableList: (node: SchemaNode) => void;
  openTableData: (node: SchemaNode) => void;
  openTableDesign: (node: SchemaNode) => void;
  refreshConnectionRoots: (name: string) => Promise<void>;
  refreshConnections: () => Promise<void>;
  withBusy: <T>(action: () => Promise<T>) => Promise<T>;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  flash: (text: string) => void;
}

/**
 * 对象树的交互动作：选中 / 双击 / 定位 / 刷新节点。
 * 依赖 schema / connection / objects / table 各域已建好的动作（在 App 处按顺序注入）。
 */
export function useSchemaActions(deps: SchemaActionsDeps) {
  const {
    setActiveNode, setExpanded, openSessions, session, setSession, rootsByConnection,
    setRoots, setCatalogOptions, setSchemaOptions, setTableNodes,
    connectionOfNode, sessionOfNode, parentTreeNode, loadChildren, toggleNode,
    focusObjectPage, showScriptList, showTableList, openScript, openScriptList, openTableList,
    openTableData, openTableDesign, refreshConnectionRoots, refreshConnections, withBusy,
    setError, setStatus, flash
  } = deps;

  /**
   * 在对象树里定位节点：展开所有祖先、选中它、滚到可视范围。
   * 只动对象树，不动工作区标签（不会把当前页顶掉）。
   */
  function revealTreeNode(node: SchemaNode) {
    const chain: string[] = [];

    for (let current: SchemaNode | null = node, guard = 0; current && guard < 16; guard++) {
      chain.push(current.id);
      current = parentTreeNode(current.id);
    }

    setExpanded(previous => {
      const next = new Set(previous);
      chain.forEach(id => next.add(id));
      return next;
    });
    setActiveNode(node);

    const scrollToRow = () => {
      const row = [...document.querySelectorAll<HTMLElement>(".tree-row")]
        .find(item => item.dataset.nodeId === node.id);

      if (!row)
        return false;

      row.scrollIntoView({ block: "center" });
      return true;
    };

    setStatus(`已定位到 ${node.label}`);

    /* 行一般已经在 DOM 里；如果刚才展开了被收起的祖先，等这一帧渲染完再滚 */
    if (!scrollToRow())
      window.requestAnimationFrame(() => scrollToRow());
  }

  /**
   * 对象树里选中节点 → 记住当前节点，并让「对象」列跟着走：
   * 库 / 表 → 数据表列表（选中哪个表就高亮哪个），脚本 → 脚本列表；
   * 连接节点会换掉「对象」页的归属（内容是那个连接的对象），但不抢当前工作标签。
   */
  function selectTreeNode(node: SchemaNode) {
    setActiveNode(node);

    /* 选到别的连接下的节点：把活动会话切过去（多连接并存，互不关闭） */
    const owner = connectionOfNode(node);
    const owned = owner ? openSessions[owner] : undefined;

    if (owned && owned.sessionId !== session?.sessionId) {
      setSession(owned);
      setRoots(rootsByConnection[owner!] ?? []);
      setCatalogOptions(rootsByConnection[owner!] ?? []);
      setSchemaOptions([]);
      setTableNodes([]);
    }

    /* 点的是连接本身：活动连接换了，「对象」页也得换成这条连接的内容 */
    if (node.kind === "CONNECTION" && owned) {
      void focusObjectPage(node.label, { session: owned, roots: rootsByConnection[node.label] ?? [] });
      return;
    }

    if (!owned && !session)
      return;

    if (node.kind === "QUERY") {
      void showScriptList({ source: node, highlightName: node.path ? node.label : undefined });
      return;
    }

    if (node.kind === "CATALOG" || node.kind === "SCHEMA" || node.kind === "TABLE")
      void showTableList(node, { quiet: true });
  }

  /* 双击对象：连接 / 展开 / 打开数据 */
  function activateNode(node: SchemaNode) {
    if (node.kind === "TABLE" && !node.hasChildren && node.table) {
      openTableData(node);
      return;
    }

    /* 查询脚本文件：双击打开到查询控制台 */
    if (node.kind === "QUERY" && node.path) {
      void openScript(node);
      return;
    }

    /* 「查询脚本」容器：双击直接进脚本对象页，比一层层展开目录更顺手 */
    if (node.kind === "QUERY") {
      void toggleNode(node);
      void openScriptList();
      return;
    }

    /* 打开数据库 / 模式：展开对象树的同时把「对象」页显示出来 */
    if (node.kind === "CATALOG" || node.kind === "SCHEMA") {
      void toggleNode(node);
      void openTableList(node);
      return;
    }

    if (node.kind === "CONNECTION" || node.hasChildren)
      void toggleNode(node);
  }

  /** 重新拉取某个节点的下一级对象（按节点自己的连接取会话，不能拿当前活动会话去套） */
  async function refreshNode(node: SchemaNode) {
    if (node.kind === "CONNECTION") {
      await refreshConnectionRoots(node.label);
      return;
    }

    if (node.kind === "ROOT") {
      await refreshConnections();
      return;
    }

    const active = sessionOfNode(node);

    if (!active) {
      setError("请先在左侧选择一个连接");
      return;
    }

    try {
      await withBusy(() => loadChildren(active.sessionId, node, true));
      setStatus(`已刷新 ${node.label}`);
      flash(`已刷新 ${node.label}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return { revealTreeNode, selectTreeNode, activateNode, refreshNode };
}
