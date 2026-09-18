import type { WorkTab } from "../app/appTypes";
import { isScriptDirty, tabIconName, type SqlResolver } from "../tabs/tabHelpers";
import { Icon } from "./icons";

/** 工作区标签条：横向滚动、拖动排序、右键菜单、中键关闭、欢迎页。 */
export function WorkTabs(props: {
  tabs: WorkTab[];
  activeTabId: string;
  tabDrag: { id: string; over: string | null; after: boolean } | null;
  tabsOverflow: boolean;
  tabsRef: { current: HTMLDivElement | null };
  setTabDrag: (updater: { id: string; over: string | null; after: boolean } | null | ((previous: { id: string; over: string | null; after: boolean } | null) => { id: string; over: string | null; after: boolean } | null)) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onMoveTab: (from: string, to: string, after: boolean) => void;
  onTabContextMenu: (id: string) => void;
  onCreateQuery: () => void;
  onRefreshConnections: () => void;
  onShowAllTabs: () => void;
  /** 取标签的最新编辑器内容（内容可能还没同步进 tabs 状态） */
  resolveSql?: SqlResolver;
}) {
  const {
    tabs, activeTabId, tabDrag, tabsOverflow, tabsRef, setTabDrag,
    onSelectTab, onCloseTab, onMoveTab, onTabContextMenu, onCreateQuery, onRefreshConnections, onShowAllTabs,
    resolveSql
  } = props;

  return (
    <>
      <div className={`work-tabs${tabs.length === 0 ? " is-hidden" : ""}`}>
        {/* 标签条：可横向滚动（滚轮 / 拖动排序），右边固定「新建」与溢出折叠菜单 */}
        <div
          className="work-tabs-strip"
          ref={tabsRef}
          onWheel={event => {
            /* 滚轮在标签栏上直接横向滚动，不用按住 Shift */
            if (event.deltaY)
              event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          {tabs.map(tab => (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              /* 「对象」列钉在最前面，不允许拖动 */
              draggable={tab.kind !== "objects"}
              className={[
                "work-tab",
                tab.id === activeTabId ? "is-active" : "",
                tabDrag?.id === tab.id ? "is-dragging" : "",
                tabDrag?.over === tab.id ? "is-drop-target" : "",
                tabDrag?.over === tab.id && tabDrag.after ? "is-drop-after" : ""
              ].filter(Boolean).join(" ")}
              onDragStart={event => {
                if (tab.kind === "objects") {
                  event.preventDefault();
                  return;
                }

                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tab.id);
                setTabDrag({ id: tab.id, over: null, after: false });
              }}
              onDragOver={event => {
                if (!tabDrag || tabDrag.id === tab.id)
                  return;

                event.preventDefault();
                event.dataTransfer.dropEffect = "move";

                const rect = event.currentTarget.getBoundingClientRect();
                const after = event.clientX > rect.left + rect.width / 2;

                setTabDrag(previous => previous ? { ...previous, over: tab.id, after } : previous);
              }}
              onDragLeave={() => setTabDrag(previous =>
                previous && previous.over === tab.id ? { ...previous, over: null } : previous)}
              onDrop={event => {
                event.preventDefault();
                const from = event.dataTransfer.getData("text/plain") || tabDrag?.id;
                const rect = event.currentTarget.getBoundingClientRect();
                const after = event.clientX > rect.left + rect.width / 2;

                setTabDrag(null);

                if (from)
                  onMoveTab(from, tab.id, after);
              }}
              onDragEnd={() => setTabDrag(null)}
              onContextMenu={event => {
                event.preventDefault();
                onTabContextMenu(tab.id);
              }}
              onAuxClick={event => {
                /* 中键关闭 */
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
            >
              <button
                type="button"
                className="work-tab-main"
                onClick={() => onSelectTab(tab.id)}
                title={tab.title}
              >
                <Icon
                  name={tabIconName(tab)}
                  size={13}
                />
                <span className="work-tab-title">{tab.title}</span>
                {/* 脚本有未保存的修改 → 标题后面点一个小圆点 */}
                {isScriptDirty(tab, resolveSql) && <span className="work-tab-dot" title="有未保存的修改" aria-label="有未保存的修改" />}
              </button>
              {/* 「对象」列常驻，不给关闭按钮 */}
              {tab.kind !== "objects" && (
                <button
                  type="button"
                  className="work-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>

        <button type="button" className="work-tab-add" aria-label="新建查询" title="新建查询" onClick={onCreateQuery}>
          <Icon name="plus" size={13} />
        </button>

        {/* 标签超出宽度时折叠成这个菜单 */}
        {tabsOverflow && (
          <button
            type="button"
            className="work-tab-add work-tabs-more"
            aria-label="全部标签"
            title="全部标签"
            onClick={onShowAllTabs}
          >
            <Icon name="chevronsRight" size={13} />
          </button>
        )}
      </div>

      {tabs.length === 0 && (
        <div className="welcome">
          <div className="welcome-title">没有打开的标签</div>
          <div className="welcome-hint">在左侧双击表打开数据，或新建一个查询控制台</div>
          <div className="welcome-actions">
            <button type="button" className="tbtn is-primary" onClick={onCreateQuery}>
              <Icon name="terminal" />新建查询
            </button>
            <button type="button" className="tbtn" onClick={onRefreshConnections}>
              <Icon name="refresh" />刷新连接
            </button>
          </div>
        </div>
      )}
    </>
  );
}
