import { useRef, useState } from "react";
import { invoke, messageOf, type OpenConnectionPayload, type SavedConnection, type SchemaNode } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import { connectionOfTab, describeUnsaved, hasUnsaved, type SqlResolver } from "../tabs/tabHelpers";

export interface ConnectionTabsApi {
  tabs: WorkTab[];
  setTabs: (updater: WorkTab[] | ((previous: WorkTab[]) => WorkTab[])) => void;
  setActiveTabId: (updater: string | ((previous: string) => string)) => void;
  activeTabId: string;
}

export interface ConnectionSessionsDeps {
  /** Tab 域的动作（App 在所有 Hook 建好后回填，避免 connection ↔ tabs 循环依赖） */
  tabsRef: { current: ConnectionTabsApi | null };
  focusObjectPage: (name: string, context?: { session?: SessionState | null; roots?: SchemaNode[] | null }) => void;
  objectTargetRef: { current: Record<string, { view: "tables" | "scripts"; node: SchemaNode | null }> };
  setExpanded: (updater: (previous: Set<string>) => Set<string>) => void;
  setLoadingNodes: (updater: (previous: Set<string>) => Set<string>) => void;
  setActiveNode: (node: SchemaNode | null) => void;
  /** 关闭连接后清空工作区相关状态（对象页 / 网格 / 信息面板等，由 App 统一负责） */
  clearUiOnDisconnect: () => void;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
  setConnectionDialog: (state: { mode: "new" | "edit" | "copy"; connection?: SavedConnection | null; initialType?: string } | null) => void;
  withBusy: <T>(action: () => Promise<T>) => Promise<T>;
  setPending: (value: string | null) => void;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  flash: (text: string) => void;
  /** 取标签的最新编辑器内容（内容可能还没同步进 tabs 状态） */
  resolveSql?: SqlResolver;
}

/**
 * 连接 / 会话域：连接列表、多连接并存的活动会话、根节点缓存，
 * 以及打开 / 关闭 / 刷新连接的生命周期。
 */
export function useConnectionSessions(deps: ConnectionSessionsDeps) {
  const {
    tabsRef, focusObjectPage, objectTargetRef, setExpanded, setLoadingNodes, setActiveNode,
    clearUiOnDisconnect, askConfirm, setConnectionDialog, withBusy, setPending, setError, setStatus, flash,
    resolveSql
  } = deps;

  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  /* 已打开的连接会话：多连接并存，key = 连接名 */
  const [openSessions, setOpenSessions] = useState<Record<string, SessionState>>({});
  /* 每个连接各自的数据库根节点 */
  const [rootsByConnection, setRootsByConnection] = useState<Record<string, SchemaNode[]>>({});
  const [roots, setRoots] = useState<SchemaNode[]>([]);
  /* 正在建立连接的连接名：防止连接未完成时被重复打开（会开出两个会话） */
  const [openingConnections, setOpeningConnections] = useState<Set<string>>(new Set());
  const openingRef = useRef<Set<string>>(new Set());
  /* 打开过程中被关闭（取消）的连接名：结果回来时丢弃，不落会话 */
  const cancelledOpensRef = useRef<Set<string>>(new Set());

  /* 断开连接后仍要能提示：记住最近一次连接的连接名与数据库类型 */
  const lastSessionRef = useRef<{ name?: string; type: string }>({ type: "mysql" });
  /* 用 ref 保存当前会话，避免异步回调里拿到已失效的 sessionId */
  const sessionRef = useRef<SessionState | null>(null);
  sessionRef.current = session;

  async function refreshConnections() {
    setPending("connections");

    try {
      const payload = await withBusy(() => invoke<{ connections: SavedConnection[] }>("connections.list"));
      setConnections(payload.connections);
      setStatus("连接列表已刷新");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  }

  /**
   * 建立 / 切换连接。
   *
   * `focusPage` 为 false 时不把「对象」页牵过去：
   * 「打开所有连接」要连着开好几条，页面来回跳没有意义，等最后定了活动连接再说。
   */
  async function openConnection(connection: SavedConnection, options: { focusPage?: boolean } = {}) {
    setError(null);

    /* 已经连上就直接切过去：多连接并存，不会把别的连接顶掉 */
    const opened = openSessions[connection.name];

    if (opened) {
      setStatus(`正在连接 ${connection.name} …`);
      setSession(opened);
      lastSessionRef.current = { name: connection.name, type: connection.type ?? lastSessionRef.current.type };
      setStatus(`已切换到 ${connection.name}`);

      let nodes = rootsByConnection[connection.name];

      /* 该连接的根节点如果还没拉过（例如刚被别的窗口清掉），补一次 */
      if (!nodes) {
        try {
          const payload = await invoke<OpenConnectionPayload>("connection.open", { name: connection.name });
          const fetched = payload.nodes;

          nodes = fetched;
          setOpenSessions(previous => ({
            ...previous,
            [connection.name]: { sessionId: payload.sessionId, name: connection.name, product: payload.product }
          }));
          setRootsByConnection(previous => ({ ...previous, [connection.name]: fetched }));
        } catch (e) {
          setError(messageOf(e));
        }
      }

      setRoots(nodes ?? []);
      setExpanded(previous => new Set(previous).add(`conn:${connection.name}`));

      /* 从别的连接切过来：对象树里上一处的选中属于原来那条连接，留着会让新建查询 / 信息面板张冠李戴 */
      if (session?.name !== connection.name)
        setActiveNode(null);

      /* 切过去了，「对象」页也得跟着换成这条连接的内容 */
      if (options.focusPage !== false)
        void focusObjectPage(connection.name, { session: opened, roots: nodes ?? [] });

      return true;
    }

    /*
     * 正在连接中：直接忽略这次调用，避免同一个连接被打开两次（会开出两个会话）。
     * 连接完成后如果连接已不在，说明期间被关闭过，同样不落会话。
     */
    if (openingRef.current.has(connection.name)) {
      setStatus(`正在连接 ${connection.name} …`);
      return false;
    }

    setStatus(`正在连接 ${connection.name} …`);

    /* 连接期间在对应节点上显示加载动画 */
    const nodeId = `conn:${connection.name}`;

    openingRef.current.add(connection.name);
    cancelledOpensRef.current.delete(connection.name);
    setOpeningConnections(previous => new Set(previous).add(connection.name));
    setLoadingNodes(previous => new Set(previous).add(nodeId));

    try {
      const payload = await withBusy(() => invoke<OpenConnectionPayload>("connection.open", { name: connection.name }));

      /* 连接过程中被关闭（取消）：结果回来直接丢弃，不落会话 */
      if (cancelledOpensRef.current.has(connection.name))
        return false;

      const next = { sessionId: payload.sessionId, name: connection.name, product: payload.product };

      setOpenSessions(previous => ({ ...previous, [connection.name]: next }));
      setSession(next);
      lastSessionRef.current = {
        name: connection.name,
        type: connection.type ?? payload.product.type ?? lastSessionRef.current.type
      };
      setRootsByConnection(previous => ({ ...previous, [connection.name]: payload.nodes }));
      setRoots(payload.nodes);
      setActiveNode(null);
      setStatus(`已连接 ${connection.name}`);

      /* 只展开连接节点本身，数据库/表等子节点保持收起，由用户按需展开 */
      setExpanded(previous => new Set(previous).add(`conn:${connection.name}`));

      /* 刚连上的连接成为活动连接：「对象」页换成它的内容，别留着上一个连接的 */
      if (options.focusPage !== false)
        void focusObjectPage(connection.name, { session: next, roots: payload.nodes });

      return true;
    } catch (e) {
      /* 取消后的失败不再报错提示 */
      if (!cancelledOpensRef.current.has(connection.name)) {
        setError(messageOf(e));
        setStatus("连接失败");
      }
      return false;
    } finally {
      cancelledOpensRef.current.delete(connection.name);
      openingRef.current.delete(connection.name);
      setOpeningConnections(previous => {
        const next = new Set(previous);
        next.delete(connection.name);
        return next;
      });
      setLoadingNodes(previous => {
        const next = new Set(previous);
        next.delete(nodeId);
        return next;
      });
    }
  }

  /**
   * 关闭某个连接（不传就是当前活动的那个）。
   * 多连接并存：只清掉这个连接的会话、根节点与它的数据页 / 设计页 / 对象页，
   * 其它连接完全不受影响；查询控制台保留（SQL 文本不丢），只清执行结果。
   *
   * `confirmed` 为 true 表示调用方已经把未保存内容统一确认过了（「关闭所有连接」），
   * 不再逐条弹窗。
   */
  async function disconnect(name?: string, options: { confirmed?: boolean } = {}) {
    const tabsApi = tabsRef.current;
    const target = name ?? session?.name;

    if (!target || !tabsApi)
      return;

    /* 正在连接中的连接被关闭：标记取消，正在进行的打开流程回来后会丢弃结果 */
    if (openingRef.current.has(target))
      cancelledOpensRef.current.add(target);

    const tabs = tabsApi.tabs;
    const targetSession = openSessions[target] ?? (session?.name === target ? session : null);
    const closingTabs = tabs.filter(tab =>
      (tab.kind === "data" || tab.kind === "design") && tab.connection === target
      || tab.kind === "objects"
      || (tab.kind === "query" && tab.path.connection === target));
    const unsaved = closingTabs.filter(tab => hasUnsaved(tab, resolveSql));

    if (!options.confirmed && unsaved.length > 0) {
      const confirmed = await askConfirm(
        `连接 ${target} 上还有没保存的内容：\n${unsaved.map(tab => describeUnsaved(tab, resolveSql)).join("\n")}\n\n关闭连接后这些改动会丢失，确定关闭吗？`,
        "未保存的修改",
        true
      );

      if (!confirmed)
        return;
    }

    if (targetSession)
      await invoke("connection.close", { sessionId: targetSession.sessionId }).catch(() => undefined);

    setOpenSessions(previous => {
      const next = { ...previous };

      delete next[target];
      return next;
    });
    setRootsByConnection(previous => {
      const next = { ...previous };

      delete next[target];
      return next;
    });
    /* 记下的对象位置属于这次会话的节点，重连后 id 全变了，留着只会指到别处 */
    delete objectTargetRef.current[target];

    /* 关掉这个连接的数据页 / 设计页 / 对象页；查询控制台只清结果，保留 SQL */
    const remaining = tabs
      .filter(tab => !((tab.kind === "data" || tab.kind === "design") && tab.connection === target))
      .filter(tab => !(tab.kind === "objects" && tab.connection === target))
      .map(tab => tab.kind === "query" && tab.path.connection === target
        ? { ...tab, result: null, plan: null, messages: [], logs: [], lastCost: null, running: false, path: {} } as WorkTab
        : tab);

    tabsApi.setTabs(remaining);
    tabsApi.setActiveTabId(previous => (remaining.some(tab => tab.id === previous) ? previous : remaining[0]?.id ?? ""));

    /* 活动会话换成还开着的另一个连接（没有就变成未连接） */
    const nextName = Object.keys(openSessions).find(item => item !== target);
    const nextSession = nextName ? openSessions[nextName] : null;

    setSession(nextSession);
    setRoots(nextSession && nextName ? rootsByConnection[nextName] ?? [] : []);
    /* 其余工作区状态（对象页 / 网格 / 信息面板 / 日志等）统一清空 */
    clearUiOnDisconnect();
    setStatus(`已关闭连接 ${target}`);
  }

  /**
   * 打开所有还没打开的连接（「我的连接 → 打开所有连接」）。
   *
   * 一条一条顺序连：每次只开一个新会话，某条连不上不影响后面；
   * 全部开完把活动连接还给原来那条，免得点一下就把工作区和「对象」页甩到最后打开的那条上。
   */
  async function openAllConnections() {
    const pending = connections.filter(item => !openSessions[item.name]);

    if (pending.length === 0) {
      setStatus("所有连接都已打开");
      flash("所有连接都已打开");
      return;
    }

    const keep = session;
    const openedNames: string[] = [];
    const failed: string[] = [];

    for (const connection of pending) {
      setStatus(`正在打开 ${connection.name} …（${openedNames.length + failed.length + 1}/${pending.length}）`);

      if (await openConnection(connection, { focusPage: false }))
        openedNames.push(connection.name);
      else
        failed.push(connection.name);
    }

    /* 活动连接还给原来那条；原来根本没连过，就落到第一条打开的连接上 */
    const back = keep && openSessions[keep.name] ? keep.name : openedNames[0];
    const connection = back ? connections.find(item => item.name === back) : undefined;

    if (connection)
      await openConnection(connection, { focusPage: !keep });

    if (failed.length > 0)
      setError(`以下连接打开失败：${failed.join("、")}`);

    setStatus(`已打开 ${openedNames.length} 个连接${failed.length > 0 ? `，失败 ${failed.length} 个` : ""}`);
  }

  /**
   * 关闭所有已打开的连接（「我的连接 → 关闭所有连接」）。
   *
   * 未保存的内容只统一确认一次（有几条连接就弹几次太折腾）。
   * 关完必须自己收尾：disconnect 里挑「下一个活动连接」用的是调用开始时的会话快照，
   * 循环里最后可能把活动会话指到已经关掉的连接上。
   */
  async function closeAllConnections() {
    const names = Object.keys(openSessions);
    const tabs = tabsRef.current?.tabs ?? [];

    if (names.length === 0) {
      setStatus("当前没有已打开的连接");
      flash("当前没有已打开的连接");
      return;
    }

    const unsaved = tabs.filter(tab => hasUnsaved(tab, resolveSql) && names.includes(connectionOfTab(tab) ?? ""));

    if (unsaved.length > 0) {
      const confirmed = await askConfirm(
        `以下标签还有没保存的内容：\n${unsaved.map(tab => describeUnsaved(tab, resolveSql)).join("\n")}\n\n关闭所有连接后这些改动会丢失，确定关闭吗？`,
        "未保存的修改",
        true
      );

      if (!confirmed)
        return;
    }

    setStatus(`正在关闭 ${names.length} 个连接 …`);

    for (const name of names)
      await disconnect(name, { confirmed: true });

    setSession(null);
    setRoots([]);
    clearUiOnDisconnect();
    setStatus(`已关闭 ${names.length} 个连接`);
  }

  /**
   * 刷新连接节点：重读这条连接的顶层库 / 模式列表（不重连，已打开的页不受影响）。
   *
   * 顶层节点只从 connection.open 里来过，树上那个 `conn:连接名` 是界面自己编的 id，
   * 拿它去问数据层就是「节点不存在」—— 所以这里走 schema.roots，并带上该连接的会话。
   */
  async function refreshConnectionRoots(name: string) {
    const owner = openSessions[name];

    if (!owner) {
      /* 还没连上：刷新等于连一次 */
      const connection = connections.find(item => item.name === name);

      if (connection)
        await openConnection(connection);

      return;
    }

    setPending("refreshNode");

    try {
      const payload = await invoke<{ nodes: SchemaNode[] }>("schema.roots", { sessionId: owner.sessionId });

      setRootsByConnection(previous => ({ ...previous, [name]: payload.nodes }));

      if (session?.name === name)
        setRoots(payload.nodes);

      setStatus(`已刷新 ${name}`);
      flash(`已刷新 ${name}`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  }

  async function deleteConnection(name: string) {
    const confirmed = await askConfirm(`确定要删除连接“${name}”吗？`, "删除连接", true);

    if (!confirmed)
      return;

    try {
      /* 正在连接 / 已连接都先关闭（连接中的会被标记取消），再删配置 */
      if (openSessions[name] || session?.name === name || openingRef.current.has(name))
        await disconnect(name);

      await invoke("connections.delete", { name });
      await refreshConnections();
      setStatus(`已删除连接 ${name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /* 连接对话框保存后：刷新连接列表；「保存并连接」再直接连上 */
  async function onConnectionSaved(name: string, options?: { connect?: boolean }) {
    setConnectionDialog(null);
    await refreshConnections();
    setStatus(`已保存连接 ${name}`);

    if (options?.connect) {
      const saved = (await invoke<{ connections: SavedConnection[] }>("connections.list")).connections
        .find(item => item.name === name);

      if (saved)
        await openConnection(saved);
    }
  }

  return {
    connections, setConnections,
    session, setSession, sessionRef, lastSessionRef,
    openSessions, setOpenSessions,
    rootsByConnection, setRootsByConnection,
    roots, setRoots,
    openingConnections,
    refreshConnections, openConnection, disconnect,
    openAllConnections, closeAllConnections, refreshConnectionRoots, deleteConnection, onConnectionSaved
  };
}
