import type { SchemaNode } from "../api";
import type { ObjectTab, QueryTab, WorkTab } from "../app/appTypes";
import { DEFAULT_SQL } from "../app/appConstants";

let tabSequence = 1;

/** 下一个标签 id（模块级自增，和原 App 里的 `tab-${tabSequence++}` 一致） */
export function nextTabId(): string {
  return `tab-${tabSequence++}`;
}

export function newQueryTab(): QueryTab {
  return {
    id: nextTabId(),
    kind: "query" as const,
    title: `查询控制台 ${tabSequence - 1}`,
    running: false,
    messages: [],
    sql: DEFAULT_SQL,
    result: null,
    plan: null,
    dirtyRows: [],
    path: {}
  };
}

/** 工作标签的图标名（标签栏与溢出折叠菜单共用） */
export function tabIconName(tab: WorkTab): string {
  if (tab.kind === "query")
    return "terminal";

  if (tab.kind === "data")
    return "table";

  if (tab.kind === "objects")
    return tab.view === "scripts" ? "code" : "list";

  return "columns";
}

/** 标签属于哪个连接 */
export function connectionOfTab(tab: WorkTab | null | undefined): string | undefined {
  if (!tab)
    return undefined;

  if (tab.kind === "query")
    return tab.path.connection ?? tab.script?.connection;

  if (tab.kind === "data" || tab.kind === "design" || tab.kind === "objects")
    return tab.connection;

  return undefined;
}

/**
 * 标签对应的对象树节点（能定位才返回）。
 * 数据页 / 设计页挂着自己的表节点，对象页挂着它的容器节点；
 * 从脚本打开的查询控制台则回到树上那个脚本节点。
 */
export function treeNodeOfTab(tab: WorkTab | null | undefined, treeChildren: Record<string, SchemaNode[]>): SchemaNode | null {
  if (!tab)
    return null;

  if (tab.kind === "data" || tab.kind === "design")
    return tab.node ?? null;

  if (tab.kind === "objects")
    return tab.node ?? null;

  if (tab.kind === "query" && tab.script) {
    const script = tab.script;

    return Object.values(treeChildren)
      .flat()
      .find(node => node.kind === "QUERY" && node.path && node.label === script.name
        && (node.catalog ?? "default") === script.catalog) ?? null;
  }

  return null;
}

/** 常驻的「对象」列（不存在时返回 null） */
export function findObjectTab(tabs: WorkTab[]): ObjectTab | null {
  return tabs.find((tab): tab is ObjectTab => tab.kind === "objects") ?? null;
}

/**
 * 关闭某个树节点下打开的标签页：
 * 连接 → 它的全部数据/设计页；数据库 → 该库下的；模式 → 该模式下的；表容器/表 → 对应的表。
 * 查询控制台与常驻的「对象」页不受影响。
 */
export function affectsTabOnNodeClose(tab: WorkTab, node: SchemaNode): boolean {
  if (tab.kind !== "data" && tab.kind !== "design")
    return false;

  const target = tab.node;

  if (node.kind === "CONNECTION")
    return true;

  if (node.kind === "CATALOG")
    return target.catalog === (node.catalog ?? node.label);

  if (node.kind === "SCHEMA")
    return target.catalog === node.catalog && target.schema === node.label;

  /* 「数据表」容器：没有表元数据，关闭它带走该容器下全部数据页 */
  if (node.kind === "TABLE" && node.hasChildren && !node.table)
    return target.catalog === node.catalog && target.schema === node.schema;

  if (node.kind === "TABLE")
    return target.label === node.label && target.catalog === node.catalog;

  return false;
}

/**
 * 拖动排序：把 from 放到 to 的前面或后面（按落点在标签的哪半边决定）；
 * 「对象」列钉在最前面，既不能被拖走，也不允许别人插到它前面。
 */
export function moveTabInList(previous: WorkTab[], from: string, to: string, after: boolean): WorkTab[] {
  if (from === to)
    return previous;

  const dragged = previous.find(tab => tab.id === from);

  if (!dragged || dragged.kind === "objects")
    return previous;

  const pinned = previous.filter(tab => tab.kind === "objects");
  const movable = previous.filter(tab => tab.kind !== "objects");
  const fromIndex = movable.findIndex(tab => tab.id === from);

  if (fromIndex < 0)
    return previous;

  const next = [...movable];

  next.splice(fromIndex, 1);

  /* 先删掉被拖的那项再找落点，索引才是准的 */
  const targetIndex = next.findIndex(tab => tab.id === to);

  if (targetIndex < 0)
    return previous;

  next.splice(after ? targetIndex + 1 : targetIndex, 0, dragged);

  return [...pinned, ...next];
}

/**
 * 计算「关闭标签」后的结果。返回 null 表示这次操作无效（对象页不能被关 / 找不到）。
 * 只做纯计算，未保存确认与 state 落位由调用方负责。
 */
export function computeCloseTabs(tabs: WorkTab[], mode: "current" | "left" | "right" | "all", id: string): { next: WorkTab[]; index: number } | null {
  const index = tabs.findIndex(tab => tab.id === id);

  if (index < 0)
    return null;

  /* 对象列是常驻页：不能被关闭，也不会被"关闭左侧/右侧/全部"带走（断连时随连接一起收走） */
  if (mode === "current" && tabs[index].kind === "objects")
    return null;

  const keep = mode === "current"
    ? (tab: WorkTab) => tab.id !== id
    : mode === "left"
      ? (_tab: WorkTab, position: number) => position >= index
      : mode === "right"
        ? (_tab: WorkTab, position: number) => position <= index
        : () => false;

  const kept = (tab: WorkTab, position: number) => tab.kind === "objects" || keep(tab, position);

  return { next: tabs.filter((tab, position) => kept(tab, position)), index };
}

/** 查询页绑定了脚本文件、且内容与上次保存的不一致 → 有未保存修改 */
export function isScriptDirty(tab: WorkTab): boolean {
  return tab.kind === "query" && Boolean(tab.script) && tab.savedSql != null && tab.savedSql !== tab.sql;
}

/** 这个标签关掉会丢东西吗：脚本没存盘 or 结果集里有未提交的修改 */
export function hasUnsaved(tab: WorkTab): boolean {
  return isScriptDirty(tab) || (tab.pending ?? 0) > 0;
}

export function describeUnsaved(tab: WorkTab): string {
  if (isScriptDirty(tab))
    return `· ${tab.title}（脚本未保存）`;

  return `· ${tab.title}（${tab.pending ?? 0} 条未提交修改）`;
}

export function closingTabsNeedConfirm(tabs: WorkTab[]): WorkTab[] {
  return tabs.filter(hasUnsaved);
}

/** 状态栏右侧的页面类型文案 */
export function tabKindLabel(kind: WorkTab["kind"] | undefined): string {
  switch (kind) {
    case "query":
      return "查询控制台";
    case "data":
      return "数据浏览";
    case "design":
      return "表结构";
    case "objects":
      return "对象列表";
    default:
      return "就绪";
  }
}
