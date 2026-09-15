import { windowControl } from "../api";
import { KEY } from "../keys";

/** 自绘标题栏：品牌 + 当前连接/库 + 窗口按钮。 */
export function AppTitlebar(props: { sessionName: string | null; currentDatabase: string; maximized: boolean }) {
  const { sessionName, currentDatabase, maximized } = props;

  return (
    <header className="titlebar">
      <span className="brand">VALKYRIE</span>
      <span className="brand-sub">
        {sessionName ? `${sessionName} · ${currentDatabase}` : "数据库客户端"}
      </span>
      <span className="titlebar-spacer" />
      <span className="titlebar-hint">{KEY.run} 执行 · {KEY.format} 格式化</span>
      <span className="window-buttons">
        <button type="button" className="win-btn" aria-label="最小化" onClick={() => windowControl("minimize")}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button
          type="button"
          className="win-btn"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => windowControl("maximize")}
        >
          {maximized
            ? <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 3h7v7H0zM3 3V0h7v7H7" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            : <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>}
        </button>
        <button type="button" className="win-btn is-close" aria-label="关闭" onClick={() => windowControl("close")}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </span>
    </header>
  );
}
