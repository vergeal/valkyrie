import { useMemo, useState } from "react";
import { invoke, messageOf, type SavedConnection } from "../api";
import { Dialog } from "./Dialog";
import { DbLogo } from "./dbLogo";
import { Icon } from "./icons";

interface ConnectionManagerProps {
  connections: SavedConnection[];
  /** 当前已连接的连接名 */
  connected: string | null;
  onClose: () => void;
  onOpen: (connection: SavedConnection) => void;
  onEdit: (mode: "new" | "edit" | "copy", connection?: SavedConnection | null) => void;
  onDelete: (connection: SavedConnection) => void;
  onRefresh: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  sqlite: "SQLite",
  dm: "达梦数据库",
  redis: "Redis"
};

/**
 * 连接管理器（参考 Navicat 的连接窗口）：
 * 一个窗口里完成新建 / 编辑 / 复制 / 删除 / 测试连接 / 打开连接，
 * 列表展示名称、类型、地址、账号与当前状态。
 */
export function ConnectionManager(props: ConnectionManagerProps) {
  const { connections, connected, onClose, onOpen, onEdit, onDelete, onRefresh } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();

    if (!needle)
      return connections;

    return connections.filter(connection =>
      [connection.name, connection.type, connection.host, connection.db, connection.username]
        .some(value => (value ?? "").toLowerCase().includes(needle)));
  }, [connections, keyword]);

  const current = connections.find(connection => connection.name === selected) ?? null;

  async function test(connection: SavedConnection) {
    setTesting(connection.name);
    setResults(previous => ({ ...previous, [connection.name]: { ok: true, text: "测试中…" } }));

    try {
      const opened = await invoke<{ sessionId: string; product: { productName?: string; version?: string } }>(
        "connection.open",
        { connection }
      );

      await invoke("connection.close", { sessionId: opened.sessionId }).catch(() => undefined);

      const product = `${opened.product?.productName ?? ""} ${opened.product?.version ?? ""}`.trim();
      setResults(previous => ({ ...previous, [connection.name]: { ok: true, text: product || "连接成功" } }));
    } catch (error) {
      setResults(previous => ({ ...previous, [connection.name]: { ok: false, text: messageOf(error) } }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <Dialog
      title={<><Icon name="plug" size={14} />连接管理</>}
      className="conn-manager"
      onClose={onClose}
    >
      <div className="manager-tools">
        <button type="button" className="tbtn" onClick={() => onEdit("new")}>
          <Icon name="plus" />新建
        </button>
        <button type="button" className="tbtn" disabled={!current} onClick={() => current && onEdit("edit", current)}>
          <Icon name="pencil" />编辑
        </button>
        <button type="button" className="tbtn" disabled={!current} onClick={() => current && onEdit("copy", current)}>
          <Icon name="copy" />复制
        </button>
        <button
          type="button"
          className="tbtn"
          disabled={!current || testing != null}
          onClick={() => current && void test(current)}
        >
          <Icon name="plug" />{testing === current?.name ? "测试中…" : "测试连接"}
        </button>
        <span className="tbtn-sep" aria-hidden="true" />
        <button
          type="button"
          className="tbtn"
          disabled={!current || current.name === connected}
          onClick={() => current && onOpen(current)}
        >
          <Icon name="play" />打开连接
        </button>
        <button
          type="button"
          className="tbtn is-danger"
          disabled={!current}
          onClick={() => current && onDelete(current)}
        >
          <Icon name="trash" />删除
        </button>
        <span className="tbtn-push" aria-hidden="true" />
        <button type="button" className="tbtn" onClick={onRefresh}>
          <Icon name="refresh" />刷新连接
        </button>
        <span className="toolbar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={keyword}
            placeholder="搜索连接…"
            aria-label="搜索连接"
            onChange={event => setKeyword(event.target.value)}
          />
        </span>
      </div>

      <div className="manager-body">
        {connections.length === 0 && <div className="empty">还没有连接，点「新建」添加一个</div>}

        {connections.length > 0 && (
          <table className="table-list conn-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>主机</th>
                <th>数据库</th>
                <th>用户名</th>
                <th>状态</th>
                <th className="table-filler" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {visible.map(connection => {
                const result = results[connection.name];
                const isConnected = connection.name === connected;

                return (
                  <tr
                    key={connection.name}
                    className={connection.name === selected ? "is-active" : undefined}
                    onClick={() => setSelected(connection.name)}
                    onDoubleClick={() => onOpen(connection)}
                  >
                    <td className="table-name">
                      <DbLogo type={connection.type} size={14} />
                      <span className="table-name-text">{connection.name}</span>
                    </td>
                    <td>{TYPE_LABEL[connection.type] ?? connection.type}</td>
                    <td>{connection.type === "sqlite" ? connection.sqlitePath ?? "-" : `${connection.host ?? "-"}:${connection.port ?? "-"}`}</td>
                    <td>{connection.db || "-"}</td>
                    <td>{connection.username || "-"}</td>
                    <td className={result ? (result.ok ? "is-ok" : "is-error") : ""} title={result?.text ?? ""}>
                      {result
                        ? result.text
                        : isConnected ? "已连接" : ""}
                    </td>
                    <td className="table-filler" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {connections.length > 0 && visible.length === 0 && (
          <div className="empty">没有匹配「{keyword}」的连接</div>
        )}
      </div>

      <div className="modal-status">
        <span className="is-muted">双击一行即可打开连接 · 共 {connections.length} 个连接</span>
      </div>

      <div className="modal-actions">
        <button type="button" className="mini-btn is-default" onClick={onClose}>关闭</button>
      </div>
    </Dialog>
  );
}
