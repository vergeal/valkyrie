/** 底部状态栏：连接 / 产品 / 当前库 / 页面类型 / 结果行数 / 状态 / 忙碌指示。 */
export function AppStatusBar(props: {
  sessionName: string | null;
  productLabel: string;
  currentDatabase: string;
  tabKind: string;
  rows: number;
  lastCost: number | null;
  status: string;
  busy: number;
}) {
  const { sessionName, productLabel, currentDatabase, tabKind, rows, lastCost, status, busy } = props;

  return (
    <footer className="statusbar">
      <span className="status-item">
        <span className={`status-dot${sessionName ? " is-on" : ""}`} aria-hidden="true" />
        {sessionName ?? "未连接"}
      </span>
      <span className="status-item">{productLabel}</span>
      <span className="status-item">{currentDatabase}</span>
      <span className="status-item">{tabKind}</span>
      <span className="status-item">结果 {rows} 行{lastCost != null ? ` / ${lastCost} ms` : ""}</span>
      <span className="status-spacer" />
      <span className="status-item">{status}</span>
      {busy > 0 && (
        <span className="status-item is-busy">
          <span className="spinner" aria-hidden="true" />处理中
        </span>
      )}
    </footer>
  );
}
