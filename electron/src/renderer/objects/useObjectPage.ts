import { useState } from "react";
import { invoke, messageOf, type SchemaNode, type ScriptFile } from "../api";
import type { ObjectTab, ObjectTabTables, SessionState, WorkTab } from "../app/appTypes";
import { OBJECT_TAB_TITLE } from "../app/appConstants";
import { connectionOfTab, findObjectTab, newQueryTab, nextTabId } from "../tabs/tabHelpers";

export interface ObjectTarget {
  view: "tables" | "scripts";
  node: SchemaNode | null;
}

export interface UseObjectPageDeps {
  session: SessionState | null;
  openSessions: Record<string, SessionState>;
  sessionRef: { current: SessionState | null };
  activeNode: SchemaNode | null;
  catalogOptions: SchemaNode[];
  roots: SchemaNode[];
  rootsByConnection: Record<string, SchemaNode[]>;
  tabs: WorkTab[];
  setTabs: (updater: WorkTab[] | ((previous: WorkTab[]) => WorkTab[])) => void;
  updateTab: (id: string, patch: Partial<WorkTab>) => void;
  setActiveTabId: (updater: string | ((previous: string) => string)) => void;
  activeTab: WorkTab | null;
  sessionOfNode: (node: SchemaNode | null | undefined, tab?: WorkTab | null) => SessionState | null;
  connectionOfNode: (node: SchemaNode | null | undefined) => string | undefined;
  sessionByName: (name?: string) => SessionState | null;
  loadTableNodes: (container: SchemaNode, force?: boolean, sessionId?: string) => Promise<SchemaNode[]>;
  firstTableContainer: (sessionId: string, node: SchemaNode) => Promise<SchemaNode | null>;
  parentTreeNode: (id: string) => SchemaNode | null;
  loadChildren: (sessionId: string, node: SchemaNode, force?: boolean) => Promise<SchemaNode[]>;
  treeChildren: Record<string, SchemaNode[]>;
  askText: (title: string, value?: string) => Promise<string | null>;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
  setPending: (value: string | null) => void;
  objectTargetRef: { current: Record<string, ObjectTarget> };
  objectTabIdRef: { current: string | null };
}

/**
 * 「对象」页（表列表 / 脚本列表）与脚本生命周期。
 * 表列表与脚本列表共用同一个常驻标签页，因此合并在一个域里维护。
 */
export function useObjectPage(deps: UseObjectPageDeps) {
  const {
    session, openSessions, sessionRef, activeNode, catalogOptions, roots, rootsByConnection,
    tabs, setTabs, updateTab, setActiveTabId, activeTab,
    sessionOfNode, connectionOfNode, sessionByName, loadTableNodes, firstTableContainer, parentTreeNode,
    loadChildren, treeChildren, askText, askConfirm, setError, setStatus, setPending,
    objectTargetRef, objectTabIdRef
  } = deps;

  /* 「对象」页选中的行（按表名匹配：树与列表分属两次查询，节点 id 不同；支持多选） */
  const [tableSelection, setTableSelection] = useState<string[]>([]);
  const [tableFilter, setTableFilter] = useState("");
  /* 刷新反馈：不弹提示，改成表格闪一下（计数变化即触发动画） */
  const [listFlash, setListFlash] = useState(0);
  /* 「脚本」页：过滤词、选中项（按脚本绝对路径）、刷新闪烁 */
  const [scriptFilter, setScriptFilter] = useState("");
  const [scriptSelection, setScriptSelection] = useState<string[]>([]);
  const [scriptFlash, setScriptFlash] = useState(0);

  /**
   * 「对象」页的唯一 id。已有页面就用它的 id；还没有则同步占一个，
   * 并发调用拿到同一个 id，落标签时按 id 合并，保证全局只有一页。
   */
  function objectTabId(): string {
    const existing = findObjectTab(tabs);

    if (existing) {
      objectTabIdRef.current = existing.id;
      return existing.id;
    }

    if (!objectTabIdRef.current)
      objectTabIdRef.current = nextTabId();

    return objectTabIdRef.current;
  }

  /** 把「对象」页按 id 落位：存在就替换内容，不存在才插到最左侧 */
  function upsertObjectTab(tab: ObjectTab) {
    setTabs(previous => previous.some(item => item.id === tab.id)
      ? previous.map(item => item.id === tab.id ? tab : item)
      : [tab, ...previous]);
  }

  /**
   * 让「对象」列显示某个节点下的数据表列表（Navicat 风格的对象页）。
   *
   * - 选中表 → 显示它所在的容器，并把该表高亮；
   * - 选中库 / 模式 / 表容器 → 显示它们下面的表容器；
   * - 页面已存在就地换内容（不会再开第二个「对象」标签），并且固定在最左侧；
   * - `force` 为 false（树选中联动）时优先用已有内容，不重新读库，但只在这个连接
   *   自己身上复用：不同连接出现同名库 / 模式时，拿过来复用就会把别的连接的表留在页面上；
   * - `session` 显式传入当前生效的会话（切连接 / 刚连上时组件状态还没落地，按名字查不到）。
   */
  async function showTableList(
    source: SchemaNode,
    options: { force?: boolean; quiet?: boolean; activate?: boolean; session?: SessionState | null } = {}
  ) {
    const owner = options.session ?? sessionOfNode(source);

    if (!owner) {
      if (!options.quiet)
        setError("请先在左侧选择一个连接");

      return;
    }

    /*
     * 连接 / 根节点自己没有表：退到这条连接的第一个库（和查询页默认选库同一个口径）。
     * 这两个节点是界面自造的 id（conn:xx / conn-root），直接拿去问数据层就是「节点不存在」。
     */
    const start = source.kind === "CONNECTION"
      ? (rootsByConnection[source.label] ?? [])[0]
      : source.kind === "ROOT" ? roots[0] : source;

    if (!start) {
      if (!options.quiet)
        setError("请先在左侧选择一个连接");

      return;
    }

    /* 选中的是表 → 展示它所在的容器，并把这个表标为当前项 */
    let target = start;
    const highlight = start.kind === "TABLE" && start.table ? start.label : null;

    if (highlight) {
      const parent = parentTreeNode(start.id);

      if (parent)
        target = parent;
    }

    const container = await firstTableContainer(owner.sessionId, target);

    if (!container) {
      /*
       * Redis 这类键值库没有表概念：打开数据库只展开对象树，
       * 不弹「没有数据表」的错误框，状态栏说明一下即可。
       * 其余情况树选中联动时也不要弹窗打扰，只在状态栏说一声。
       */
      if ((owner.product?.type ?? "").toLowerCase() === "redis")
        setStatus("Redis 没有数据表，请在查询控制台执行命令");
      else if (options.quiet)
        setStatus(`${target.label} 下没有数据表`);
      else
        setError(`${target.label} 下没有数据表`);

      return;
    }

    const objectId = objectTabId();
    const existing = tabs.find((tab): tab is ObjectTab => tab.id === objectId && tab.kind === "objects") ?? null;
    const sameContainer = existing?.connection === owner.name
      && existing.view === "tables" && existing.node
      && existing.node.catalog === container.catalog
      && existing.node.schema === container.schema;

    /* 已经在看同一批表：只切过去 / 改高亮，不重新读库 */
    if (existing && sameContainer && !options.force) {
      /* 切连接时换内容但不抢当前的工作标签 */
      if (options.activate !== false)
        setActiveTabId(existing.id);

      setTableSelection(highlight ? [highlight] : []);
      return;
    }

    const tables = await loadTableNodes(container, options.force ?? false, owner.sessionId);

    objectTargetRef.current[owner.name] = { view: "tables", node: container };

    /*
     * 只有「从一个容器切到另一个容器」才让列表"空一下再出现"。
     * 首次创建对象页（existing 为空）本来就没有旧内容可换，双击又会先后触发
     * 选中与打开两条路径、各读一次库，若每次都闪就会连闪两次。
     */
    if (existing && !sameContainer)
      setListFlash(previous => previous + 1);

    const tab: ObjectTab = {
      id: objectId,
      kind: "objects",
      view: "tables",
      connection: owner.name,
      title: OBJECT_TAB_TITLE,
      running: false,
      messages: [],
      node: container,
      tables,
      scripts: existing?.scripts ?? [],
      loading: false
    };

    upsertObjectTab(tab);

    if (options.activate !== false)
      setActiveTabId(tab.id);

    setTableFilter("");
    setTableSelection(highlight ? [highlight] : []);
  }

  /** 显式打开表列表（工具栏 / 右键 / 菜单）：重新读一遍表 */
  async function openTableList(source: SchemaNode) {
    await showTableList(source, { force: true });
  }

  /**
   * 活动连接换成另一条连接后，把常驻的「对象」页也交给它：
   * 有记过的位置就回到那儿，没有就退回这条连接的第一个库（和查询页默认选库同一个口径）——
   * 总之页面上不能继续留着上一个连接的表 / 脚本。
   *
   * 切连接只是换「对象」页的内容，不抢当前工作标签（activate 恒为 false）。
   */
  async function focusObjectPage(
    name: string,
    context: { session?: SessionState | null; roots?: SchemaNode[] | null } = {}
  ) {
    const page = findObjectTab(tabs);

    if (!page || page.connection === name)
      return;

    /* 刚连上 / 刚切换时组件状态还没落地，会话与根节点以调用方手里的那份为准 */
    const owner = context.session ?? openSessions[name];

    if (!owner)
      return;

    const remembered = objectTargetRef.current[name];

    if (remembered?.view === "scripts") {
      await showScriptList({ session: owner, activate: false });
      return;
    }

    const node = remembered?.node ?? (context.roots ?? [])[0];

    if (node) {
      await showTableList(node, { quiet: true, session: owner, activate: false });
      return;
    }

    /* 这条连接还没拿到根节点：宁可把页收掉，也不要留着别的连接的内容 */
    setTabs(previous => previous.filter(tab => tab.id !== page.id));
  }

  async function refreshTableList(tabId: string, container: SchemaNode) {
    const tab = tabs.find(item => item.id === tabId);

    setPending("tableList");
    updateTab(tabId, { loading: true, view: "tables" });

    try {
      const tables = await loadTableNodes(container, true, sessionByName(connectionOfTab(tab))?.sessionId ?? undefined);

      /* 顺带把标签页绑定的容器节点换成刚读到的这份，后续刷新继续对齐 */
      updateTab(tabId, { view: "tables", tables, node: container, loading: false, title: OBJECT_TAB_TITLE });
      setStatus(`已刷新 ${tables.length} 张表`);
      setListFlash(previous => previous + 1);
    } catch (e) {
      updateTab(tabId, { loading: false });
      setError(messageOf(e));
    } finally {
      setPending(null);
    }
  }

  /* ------------------------------ 查询脚本 ------------------------------ */

  /** 打开脚本文件（对象树里的脚本节点与「脚本」页共用一条路径） */
  async function openScriptFile(file: { name: string; catalog: string; connection?: string }) {
    /* 脚本页属于某个连接，打开时要按它的连接读，不能跟着当前活动会话 */
    const owner = file.connection ? sessionByName(file.connection) : session;

    if (!owner) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const connection = owner.name;
    const existing = tabs.find(tab =>
      tab.kind === "query" && tab.script?.name === file.name && tab.script?.catalog === file.catalog
      && tab.script?.connection === connection);

    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    try {
      const payload = await invoke<{ content: string }>("queryFiles.read", {
        connection,
        catalog: file.catalog,
        name: file.name
      });

      const tab = newQueryTab();
      tab.title = file.name;
      tab.sql = payload.content;
      tab.savedSql = payload.content;
      tab.script = { connection, catalog: file.catalog, name: file.name };
      tab.path = { connection, catalog: file.catalog };

      setTabs(previous => [...previous, tab]);
      setActiveTabId(tab.id);
      setStatus(`已打开脚本 ${file.name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function openScript(node: SchemaNode) {
    await openScriptFile({
      name: node.label,
      catalog: node.catalog ?? "default",
      connection: connectionOfNode(node)
    });
  }

  /** 当前上下文所属的数据库目录（脚本按「连接/数据库」分目录存放） */
  function scriptCatalog(): string {
    if (activeNode?.kind === "CATALOG")
      return activeNode.label;

    return activeNode?.catalog ?? catalogOptions[0]?.label ?? "default";
  }

  /** 新建脚本：问到名字后写进当前上下文所在的数据库目录，并直接打开 */
  async function createScript(catalogHint?: string) {
    const active = sessionRef.current;

    if (!active) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const catalog = catalogHint ?? scriptCatalog();
    const name = await askText(`新建脚本（保存到 ${catalog}）`, "新建查询.sql");

    if (!name)
      return;

    const fileName = name.toLowerCase().endsWith(".sql") ? name : `${name}.sql`;
    const content = `-- ${fileName.replace(/\.sql$/i, "")}\n`;

    try {
      await invoke("queryFiles.save", { connection: active.name, catalog, name: fileName, content });

      await refreshScriptTree();

      /* 对象列正显示脚本就同步刷新，不然新脚本看不见；显示表列表时不要顶掉它 */
      const listTab = findObjectTab(tabs);

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      await openScriptFile({ name: fileName, catalog });
      setStatus(`已创建脚本 ${fileName}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** 重命名脚本（新名字不带 .sql 时自动补上） */
  async function renameScriptFile(file: { name: string; catalog: string }) {
    const active = sessionRef.current;

    if (!active)
      return;

    const input = await askText(`重命名脚本（${file.catalog}）`, file.name);

    if (!input)
      return;

    const name = input.toLowerCase().endsWith(".sql") ? input : `${input}.sql`;

    if (name === file.name)
      return;

    try {
      await invoke("queryFiles.rename", {
        connection: active.name,
        catalog: file.catalog,
        oldName: file.name,
        newName: name
      });

      /* 已打开的标签同步改名，避免保存时写回旧文件 */
      setTabs(previous => previous.map(tab =>
        tab.kind === "query" && tab.script?.name === file.name && tab.script?.catalog === file.catalog
          ? { ...tab, title: name, script: { ...tab.script, name } }
          : tab));

      await refreshScriptTree();

      const listTab = findObjectTab(tabs);

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      setStatus(`已重命名为 ${name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function renameScript(node: SchemaNode) {
    await renameScriptFile({ name: node.label, catalog: node.catalog ?? "default" });
  }

  /** 删除脚本：支持一次删多个（脚本页多选后删除） */
  async function deleteScriptFiles(files: { name: string; catalog: string }[]) {
    const active = sessionRef.current;

    if (!active || files.length === 0)
      return;

    const title = files.length === 1 ? files[0].name : `选中的 ${files.length} 个脚本`;
    const confirmed = await askConfirm(`确认删除 ${title}？删除后无法恢复。`, "删除脚本", true);

    if (!confirmed)
      return;

    try {
      for (const file of files)
        await invoke("queryFiles.delete", { connection: active.name, catalog: file.catalog, name: file.name });

      /* 关掉这些脚本对应的查询页 */
      const opened = tabs.filter(tab =>
        tab.kind === "query" && tab.script && files.some(file => file.name === tab.script?.name && file.catalog === tab.script?.catalog));

      if (opened.length > 0)
        setTabs(previous => previous.filter(tab => !opened.some(item => item.id === tab.id)));

      await refreshScriptTree();

      const listTab = findObjectTab(tabs);

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      setScriptSelection([]);
      setStatus(`已删除 ${files.length} 个脚本`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function deleteScript(node: SchemaNode) {
    await deleteScriptFiles([{ name: node.label, catalog: node.catalog ?? "default" }]);
  }

  /* 拉取某个连接下所有数据库目录里的脚本（脚本对象页数据源） */
  async function loadScriptFiles(active: SessionState | null): Promise<ScriptFile[]> {
    if (!active)
      return [];

    const payload = await invoke<{ files: ScriptFile[] }>("queryFiles.list", { connection: active.name });
    /* 脚本页是整连接共用的，点开时要按它所属连接读，这里把归属带上 */
    return (payload.files ?? []).map(file => ({ ...file, connection: active.name }));
  }

  /**
   * 让「对象」列显示脚本列表（某个连接下所有库的 .sql）。
   * 与表列表共用同一个「对象」标签，只是切换内容；选中脚本节点时会定位到那一行。
   * 页面属于哪个连接由 `source`（树上的脚本节点）/ `session` 决定，不跟着活动会话瞎猜。
   */
  async function showScriptList(
    options: { force?: boolean; highlightName?: string; source?: SchemaNode; session?: SessionState | null; activate?: boolean } = {}
  ) {
    const owner = options.session ?? (options.source ? sessionOfNode(options.source) : sessionRef.current);

    if (!owner) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const objectId = objectTabId();
    const existing = tabs.find((tab): tab is ObjectTab => tab.id === objectId && tab.kind === "objects") ?? null;

    /* 已经在看这个连接的脚本列表：只切过去 / 定位，不重新扫目录 */
    if (existing?.connection === owner.name && existing.view === "scripts" && !options.force) {
      if (options.activate !== false)
        setActiveTabId(existing.id);

      highlightScript(existing, options.highlightName);
      return;
    }

    const scripts = await loadScriptFiles(owner).catch(error => {
      setError(messageOf(error));
      return [] as ScriptFile[];
    });

    objectTargetRef.current[owner.name] = { view: "scripts", node: null };
    setScriptFlash(previous => previous + 1);

    if (existing) {
      setTabs(previous => previous.map(tab => tab.id === existing.id
        ? { ...tab, view: "scripts", connection: owner.name, scripts, loading: false, title: OBJECT_TAB_TITLE } as WorkTab
        : tab));

      if (options.activate !== false)
        setActiveTabId(existing.id);

      setScriptFilter("");
      highlightScript({ scripts }, options.highlightName);
      return;
    }

    const tab: ObjectTab = {
      id: objectId,
      kind: "objects",
      view: "scripts",
      connection: owner.name,
      title: OBJECT_TAB_TITLE,
      running: false,
      messages: [],
      node: null,
      tables: [],
      scripts,
      loading: false
    };

    /* 「对象」列固定在标签栏最左侧；并发调用按 id 合并成一页 */
    upsertObjectTab(tab);

    if (options.activate !== false)
      setActiveTabId(tab.id);

    setScriptFilter("");
    highlightScript({ scripts }, options.highlightName);
  }

  /** 按脚本文件名定位选中项（树节点只有名字，选中状态用的是绝对路径） */
  function highlightScript(source: { scripts: ScriptFile[] }, name?: string) {
    const hit = name ? source.scripts.find(script => script.name === name) : undefined;

    setScriptSelection(hit ? [hit.path] : []);
  }

  /** 显式打开脚本列表（工具栏 / 右键 / 菜单）：重新扫一遍脚本目录 */
  async function openScriptList() {
    await showScriptList({ force: true });
  }

  async function refreshScriptList(tabId: string) {
    /* 页面自己记着属于哪个连接：刷新要按它的连接走，不能跟着当前活动连接 */
    const owner = sessionByName(connectionOfTab(tabs.find(tab => tab.id === tabId)));

    if (!owner) {
      setError("请先在左侧选择一个连接");
      return;
    }

    updateTab(tabId, { loading: true, view: "scripts" });

    try {
      const scripts = await loadScriptFiles(owner);

      updateTab(tabId, { view: "scripts", scripts, loading: false, title: OBJECT_TAB_TITLE });
      setScriptFlash(previous => previous + 1);
    } catch (e) {
      updateTab(tabId, { loading: false });
      setError(messageOf(e));
    }
  }

  /* 刷新对象树里所有「查询脚本」容器，让树上的脚本列表跟上文件变化 */
  async function refreshScriptTree() {
    const containers = Object.values(treeChildren)
      .flat()
      .filter(node => node.kind === "QUERY" && !node.path);

    /* 每个容器用自己所属连接的会话重读：多连接并存时按活动连接读会全部落空 */
    await Promise.all(containers.map(node => {
      const owner = sessionOfNode(node);

      return owner ? loadChildren(owner.sessionId, node, true).catch(() => []) : Promise.resolve([]);
    }));
  }

  async function saveActiveScript(saveAs = false) {
    if (!activeTab || activeTab.kind !== "query")
      return;

    if (!session) {
      setError("请先连接数据库，再保存脚本");
      return;
    }

    const script = activeTab.script;
    const content = activeTab.sql;
    const catalog = activeTab.path.catalog ?? scriptCatalog();
    /* 已有脚本就存回它原本的数据库目录，避免另存为跑到别的库里去 */
    const target = script?.catalog ?? catalog;

    try {
      if (!script || saveAs) {
        const name = await askText(`保存查询脚本（${target}）`, script?.name ?? `${activeTab.title}.sql`);

        if (!name)
          return;

        const fileName = name.toLowerCase().endsWith(".sql") ? name : `${name}.sql`;

        await invoke("queryFiles.save", {
          connection: session.name,
          catalog: target,
          name: fileName,
          content
        });

        updateTab(activeTab.id, {
          title: fileName,
          savedSql: content,
          script: { connection: session.name, catalog: target, name: fileName }
        });

        await refreshScriptTree();

        const listTab = findObjectTab(tabs);

        if (listTab?.view === "scripts")
          void refreshScriptList(listTab.id);

        setStatus(`已保存脚本 ${fileName}`);
        return;
      }

      await invoke("queryFiles.save", {
        connection: script.connection,
        catalog: script.catalog,
        name: script.name,
        content
      });

      updateTab(activeTab.id, { savedSql: content });

      const listTab = findObjectTab(tabs);

      if (listTab?.view === "scripts")
        void refreshScriptList(listTab.id);

      setStatus(`已保存脚本 ${script.name}`);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /* 「对象」页当前选中的表（工具栏的打开/设计按钮作用于全部选中项） */
  const objectSelections = activeTab?.kind === "objects" && activeTab.view === "tables"
    ? activeTab.tables.filter(node => tableSelection.includes(node.label))
    : [];

  /* 对象列（脚本视图）里选中的脚本 */
  const scriptSelections = activeTab?.kind === "objects" && activeTab.view === "scripts"
    ? activeTab.scripts.filter(script => scriptSelection.includes(script.path))
    : [];

  return {
    tableSelection, setTableSelection, tableFilter, setTableFilter, listFlash,
    scriptFilter, setScriptFilter, scriptSelection, setScriptSelection, scriptFlash,
    objectSelections, scriptSelections,
    showTableList, openTableList, focusObjectPage, refreshTableList,
    openScriptFile, openScript, scriptCatalog, createScript, renameScriptFile, renameScript,
    deleteScriptFiles, deleteScript, loadScriptFiles, showScriptList, highlightScript,
    openScriptList, refreshScriptList, refreshScriptTree, saveActiveScript
  };
}
