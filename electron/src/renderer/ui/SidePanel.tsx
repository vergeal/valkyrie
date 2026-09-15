import type { SchemaNode } from "../api";
import type { MenuEntry } from "./Menu";
import { Icon } from "./icons";
import { Tree } from "./Tree";

/** 左侧「对象导航」面板：连接刷新入口 + 搜索框 + 对象树。 */
export function SidePanel(props: {
  treeRoot: SchemaNode;
  treeChildren: Record<string, SchemaNode[]>;
  expanded: Set<string>;
  loadingNodes: Set<string>;
  activeNodeId: string | null;
  treeFilter: string;
  refreshingConnections: boolean;
  onTreeFilterChange: (value: string) => void;
  onRefreshConnections: () => void;
  onToggle: (node: SchemaNode) => void;
  onSelect: (node: SchemaNode) => void;
  onActivate: (node: SchemaNode) => void;
  onOpenData: (node: SchemaNode) => void;
  onDesign: (node: SchemaNode) => void;
  onCopyName: (node: SchemaNode) => void;
  menuFor: (node: SchemaNode) => MenuEntry[];
}) {
  const {
    treeRoot, treeChildren, expanded, loadingNodes, activeNodeId, treeFilter, refreshingConnections,
    onTreeFilterChange, onRefreshConnections, onToggle, onSelect, onActivate, onOpenData, onDesign,
    onCopyName, menuFor
  } = props;

  return (
    <aside className="side">
      <div className="side-head">
        <span className="side-title">对象导航</span>
        <span className="side-head-actions">
          <button
            type="button"
            className="side-action"
            disabled={refreshingConnections}
            onClick={onRefreshConnections}
          >
            <Icon name="refresh" size={13} />刷新连接
          </button>
        </span>
      </div>

      <div className="side-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          placeholder="搜索对象…"
          aria-label="搜索数据库对象"
          value={treeFilter}
          onChange={event => onTreeFilterChange(event.target.value)}
        />
      </div>

      <Tree
        root={treeRoot}
        childrenMap={treeChildren}
        expanded={expanded}
        loading={loadingNodes}
        activeId={activeNodeId}
        filter={treeFilter}
        onToggle={onToggle}
        onSelect={onSelect}
        onActivate={onActivate}
        onOpenData={onOpenData}
        onDesign={onDesign}
        onCopyName={onCopyName}
        menuFor={menuFor}
      />
    </aside>
  );
}
