import { Icon } from "./icons";

/** 顶部工具条：新建连接 / 查询、对象入口、行数限制与主题切换。 */
export function AppToolbar(props: {
  canOpenTableList: boolean;
  pageSize: number;
  themeLabel: string;
  themeIcon: string;
  onNewConnection: () => void;
  onNewQuery: () => void;
  onOpenTableList: () => void;
  onOpenScriptList: () => void;
  onCycleTheme: () => void;
}) {
  const {
    canOpenTableList, pageSize, themeLabel, themeIcon,
    onNewConnection, onNewQuery, onOpenTableList, onOpenScriptList, onCycleTheme
  } = props;

  return (
    <div className="toolbar">
      {/* 新建连接（二级菜单选库类型）：原来这里是「刷新连接」按钮 */}
      <button
        type="button"
        className="tbtn"
        title="新建连接（选择数据库类型）"
        onClick={onNewConnection}
      >
        <Icon name="plus" />新建连接
      </button>
      <button type="button" className="tbtn" onClick={onNewQuery}>
        <Icon name="terminal" />新建查询
      </button>
      <button
        type="button"
        className="tbtn"
        disabled={!canOpenTableList}
        title="打开当前对象的表列表"
        onClick={onOpenTableList}
      >
        <Icon name="list" />表列表
      </button>
      <button
        type="button"
        className="tbtn"
        disabled={!canOpenTableList}
        title="查看 / 管理本地 SQL 脚本"
        onClick={onOpenScriptList}
      >
        <Icon name="code" />脚本
      </button>
      <span className="tbtn-push" aria-hidden="true" />
      <span className="toolbar-text">行数限制 {pageSize}</span>
      <span className="tbtn-sep" aria-hidden="true" />
      <button type="button" className="tbtn" onClick={onCycleTheme}>
        <Icon name={themeIcon} />
        {themeLabel}
      </button>
    </div>
  );
}
