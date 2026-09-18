import { useEffect, useRef, useState } from "react";
import type { SavedConnection } from "../api";
import type { QueryTab, ResultPane, SessionState, WorkTab } from "../app/appTypes";
import { computeCloseTabs, describeUnsaved, hasUnsaved, newQueryTab, type SqlResolver } from "./tabHelpers";

interface UseTabsOptions {
  connections: SavedConnection[];
  session: SessionState | null;
  openConnection: (connection: SavedConnection, options?: { focusPage?: boolean }) => Promise<boolean>;
  getSelectionContext: () => { connection?: string; catalog?: string; schema?: string };
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
  setResultPane: (pane: ResultPane) => void;
  /** 取标签的最新编辑器内容（内容可能还没同步进 tabs 状态） */
  resolveSql?: SqlResolver;
}

/**
 * Tab 域：标签状态、拖动排序中转态、溢出检测、以及新建 / 关闭标签命令。
 * 标签内容本身由各 domain（查询 / 数据 / 设计 / 对象）维护。
 */
export function useTabs(options: UseTabsOptions) {
  const { connections, session, openConnection, getSelectionContext, askConfirm, setResultPane, resolveSql } = options;

  /* 启动时不预置标签，关闭后也不会自动补一个 */
  const [tabs, setTabs] = useState<WorkTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");
  /* 标签栏：拖动排序的中转状态 + 是否溢出（溢出时显示折叠菜单） */
  const [tabDrag, setTabDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null;

  function updateTab(id: string, patch: Partial<WorkTab>) {
    setTabs(previous => previous.map(tab => tab.id === id ? { ...tab, ...patch } as WorkTab : tab));
  }

  /** 更新当前查询标签的执行上下文（连接 / 库 / 模式 / 表） */
  function updateQueryPath(patch: Partial<QueryTab["path"]>) {
    setTabs(previous => previous.map(tab =>
      tab.id === activeTabId && tab.kind === "query" ? { ...tab, path: { ...tab.path, ...patch } } : tab));
  }

  function createQueryTab() {
    void openQueryTab();
  }

  /**
   * 新建查询：执行上下文跟随对象树里当前选中的节点
   * （选中哪个连接 / 数据库 / 模式 / 表，就用哪个；选中的连接不是当前会话时先切过去）
   */
  async function openQueryTab(): Promise<QueryTab | undefined> {
    const context = getSelectionContext();
    const target = context.connection
      ? connections.find(item => item.name === context.connection)
      : undefined;

    if (target && target.name !== session?.name) {
      const opened = await openConnection(target);

      if (!opened)
        return;
    }

    const tab = newQueryTab();
    /* 记住这个控制台属于哪个连接：断开连接后补全靠它的快照 */
    tab.path = { connection: context.connection, catalog: context.catalog, schema: context.schema };

    setTabs(previous => [...previous, tab]);
    setActiveTabId(tab.id);
    setResultPane("grid");

    return tab;
  }

  /** 关闭标签：当前 / 其他 / 左侧 / 右侧 / 全部（有没保存的脚本时先确认） */
  async function closeTabs(mode: "current" | "others" | "left" | "right" | "all", id: string) {
    const plan = computeCloseTabs(tabs, mode, id);

    if (!plan)
      return;

    const { next, index } = plan;
    /* 被关掉的那些标签（对象页常驻，不参与关闭） */
    const closing = tabs.filter(tab => !next.some(item => item.id === tab.id));
    const unsaved = closing.filter(tab => hasUnsaved(tab, resolveSql));

    if (unsaved.length > 0) {
      const confirmed = await askConfirm(
        `以下标签还有没保存的内容：\n${unsaved.map(tab => describeUnsaved(tab, resolveSql)).join("\n")}\n\n关闭后改动会丢失，确定关闭吗？`,
        "未保存的修改",
        true
      );

      if (!confirmed)
        return;
    }

    setTabs(next);

    if (!next.some(tab => tab.id === activeTabId))
      setActiveTabId(next[Math.min(index, next.length - 1)]?.id ?? "");
  }

  function closeTab(id: string) {
    void closeTabs("current", id);
  }

  /* 标签条内容超出可视宽度 → 显示右侧的折叠菜单 */
  const tabsSignature = tabs.map(tab => tab.title).join("\u0001");

  useEffect(() => {
    const element = tabsRef.current;

    if (!element)
      return;

    const check = () => setTabsOverflow(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(check);

    check();
    observer.observe(element);
    window.addEventListener("resize", check);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [tabsSignature]);

  /* 切标签时把它滚进可视范围，标签多的时候也能看到当前页 */
  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabsSignature]);

  return {
    tabs, setTabs, activeTabId, setActiveTabId, activeTab,
    tabDrag, setTabDrag, tabsOverflow, tabsRef,
    updateTab, createQueryTab, openQueryTab, closeTabs, closeTab, updateQueryPath
  };
}
