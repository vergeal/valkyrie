import type { RunRecord } from "../core";
import { Icon } from "../../ui/icons";

const STATUS_ICON: Record<string, { icon: string; className: string }> = {
  running: { icon: "refresh", className: "is-running" },
  success: { icon: "ok", className: "is-success" },
  failed: { icon: "fail", className: "is-failed" },
  cancelled: { icon: "stop", className: "is-failed" },
  pending: { icon: "clock", className: "is-pending" },
  skipped: { icon: "clock", className: "is-pending" }
};

function duration(run: RunRecord, startedAt?: number, finishedAt?: number): string {
  if (!startedAt)
    return "";

  const end = finishedAt ?? run.finishedAt ?? Date.now();
  return `${end - startedAt} ms`;
}

export function RunPanel({ run }: { run: RunRecord | null }) {
  if (!run) {
    return (
      <aside className="am-run">
        <div className="am-run-title">运行记录</div>
        <div className="am-empty">点击「运行」开始执行</div>
      </aside>
    );
  }

  const status = STATUS_ICON[run.status] ?? STATUS_ICON.pending;
  const nodes = Object.values(run.nodes);

  return (
    <aside className="am-run">
      <div className="am-run-head">
        <span className={`am-run-status ${status.className}`}>
          <Icon name={status.icon} size={13} />{run.status}
        </span>
        <span className="am-run-time">{duration(run, run.startedAt)}</span>
      </div>
      {run.error && <div className="am-run-error">{run.error}</div>}

      <div className="am-run-section">节点</div>
      <div className="am-run-nodes">
        {nodes.length === 0 && <div className="am-empty">没有执行记录</div>}
        {nodes.map(state => {
          const icon = STATUS_ICON[state.status] ?? STATUS_ICON.pending;

          return (
            <div className="am-run-node" key={state.nodeId}>
              <span className={`am-run-node-status ${icon.className}`}><Icon name={icon.icon} size={12} /></span>
              <span className="am-run-node-title">{state.title}</span>
              <span className="am-run-node-time">{duration(run, state.startedAt, state.finishedAt)}</span>
              {state.error && <span className="am-run-node-error" title={state.error}>{state.error}</span>}
            </div>
          );
        })}
      </div>

      <div className="am-run-section">日志</div>
      <div className="am-run-logs">
        {run.logs.length === 0 && <div className="am-empty">暂无日志</div>}
        {run.logs.map(entry => (
          <div className={`am-run-log is-${entry.level}`} key={entry.id}>{entry.message}</div>
        ))}
      </div>
    </aside>
  );
}
