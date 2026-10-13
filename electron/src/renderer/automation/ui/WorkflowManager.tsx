import { useEffect, useMemo, useState } from "react";
import {
  deleteWorkflow, listWorkflows, loadWorkflow, renameWorkflow, revealPath, saveWorkflow
} from "../../api";
import type { WorkflowFileMeta } from "../sdk";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/icons";

export interface WorkflowManagerProps {
  /** 当前画布里的工作流名（列表里高亮） */
  current: string;
  onClose: () => void;
  /** 打开到画布（会先确认未保存的改动） */
  onOpen: (name: string) => Promise<void>;
  /** 新建一份空工作流并打开 */
  onCreate: (name: string) => Promise<void>;
  /** 当前文件被改名 / 删除后同步画布标题 */
  onRenamed: (from: string, to: string) => void;
  onDeleted: (name: string) => void;
  onStatus: (message: string) => void;
  onError: (message: string | null) => void;
  askText: (title: string, value?: string) => Promise<string | null>;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
}

function formatTime(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 工作流管理：一个窗口里完成新建 / 打开 / 重命名 / 复制 / 删除 / 在文件夹中显示，
 * 列表按最近修改排序，可搜索。文件都放在 userData/workflows 下。
 */
export function WorkflowManager(props: WorkflowManagerProps) {
  const { current, onClose, onOpen, onCreate, onRenamed, onDeleted, onStatus, onError, askText, askConfirm } = props;
  const [files, setFiles] = useState<WorkflowFileMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setFiles(await listWorkflows());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 打开后列表里高亮当前那份 */
  useEffect(() => {
    setSelected(previous => previous ?? (current || null));
  }, [current]);

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();

    return needle ? files.filter(file => file.name.toLowerCase().includes(needle)) : files;
  }, [files, keyword]);

  const picked = visible.find(file => file.name === selected) ?? null;

  /* 动作串行执行：避免连点两下「删除」时两个请求交叉 */
  async function run(action: () => Promise<void>) {
    if (busy)
      return;

    setBusy(true);

    try {
      await action();
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = await askText("新建工作流", "未命名工作流");

    if (!name)
      return;

    await run(async () => {
      await onCreate(name);
      onStatus(`已新建工作流「${name}」`);
    });
  }

  async function open(name: string) {
    await run(async () => {
      await onOpen(name);
      onClose();
    });
  }

  async function rename(file: WorkflowFileMeta) {
    const name = await askText("重命名工作流", file.name);

    if (!name || name === file.name)
      return;

    await run(async () => {
      const result = await renameWorkflow(file.name, name);

      if (!result.ok)
        throw new Error(result.error ?? "重命名失败");

      setSelected(name);
      onRenamed(file.name, name);
      onStatus(`已重命名为「${name}」`);
    });
  }

  async function duplicate(file: WorkflowFileMeta) {
    const name = await askText("复制工作流", `${file.name} 副本`);

    if (!name || name === file.name)
      return;

    await run(async () => {
      const loaded = await loadWorkflow(file.name);

      if (!loaded)
        throw new Error("工作流读取失败");

      const result = await saveWorkflow(name, loaded.graph);

      if (!result.ok)
        throw new Error(result.error ?? "复制失败");

      setSelected(name);
      onStatus(`已复制为「${name}」`);
    });
  }

  async function remove(file: WorkflowFileMeta) {
    const confirmed = await askConfirm(`删除工作流「${file.name}」？删除后无法恢复。`, "删除工作流", true);

    if (!confirmed)
      return;

    await run(async () => {
      await deleteWorkflow(file.name);
      setSelected(null);
      onDeleted(file.name);
      onStatus(`已删除工作流「${file.name}」`);
    });
  }

  return (
    <Dialog
      title={<><Icon name="workflow" size={14} />工作流管理</>}
      className="conn-manager workflow-manager"
      onClose={onClose}
    >
      <div className="manager-tools">
        <button type="button" className="tbtn" disabled={busy} onClick={() => void create()}>
          <Icon name="plus" />新建
        </button>
        <button type="button" className="tbtn" disabled={!picked || busy} onClick={() => picked && void open(picked.name)}>
          <Icon name="folderOpen" />打开
        </button>
        <button type="button" className="tbtn" disabled={!picked || busy} onClick={() => picked && void rename(picked)}>
          <Icon name="pencil" />重命名
        </button>
        <button type="button" className="tbtn" disabled={!picked || busy} onClick={() => picked && void duplicate(picked)}>
          <Icon name="copy" />复制
        </button>
        <span className="tbtn-sep" aria-hidden="true" />
        <button
          type="button"
          className="tbtn"
          disabled={!picked || busy || !picked.path}
          onClick={() => picked?.path && void revealPath(picked.path)}
        >
          <Icon name="locate" />在文件夹中显示
        </button>
        <button type="button" className="tbtn is-danger" disabled={!picked || busy} onClick={() => picked && void remove(picked)}>
          <Icon name="trash" />删除
        </button>
        <span className="tbtn-push" aria-hidden="true" />
        <button type="button" className="tbtn" onClick={() => void refresh()}>
          <Icon name="refresh" />刷新
        </button>
        <span className="toolbar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={keyword}
            placeholder="搜索工作流…"
            aria-label="搜索工作流"
            onChange={event => setKeyword(event.target.value)}
          />
        </span>
      </div>

      <div className="manager-body">
        {files.length === 0 && <div className="empty">还没有工作流，点「新建」建一个</div>}

        {files.length > 0 && (
          <table className="table-list conn-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>最近修改</th>
                <th>大小</th>
                <th className="table-filler" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {visible.map(file => (
                <tr
                  key={file.name}
                  className={file.name === selected ? "is-active" : undefined}
                  onClick={() => setSelected(file.name)}
                  onDoubleClick={() => void open(file.name)}
                >
                  {/* 名称的内容包一层：单元格本身保持 table-cell 才会铺满整列，选中背景才连成一条 */}
                  <td className="table-name-cell">
                    <span className="table-name">
                      <Icon name="workflow" size={14} />
                      <span className="table-name-text">{file.name}</span>
                      {file.name === current && <span className="table-badge">当前</span>}
                    </span>
                  </td>
                  <td>{formatTime(file.modified)}</td>
                  <td>{formatSize(file.size)}</td>
                  <td className="table-filler" />
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {files.length > 0 && visible.length === 0 && (
          <div className="empty">没有匹配「{keyword}」的工作流</div>
        )}
      </div>

      <div className="modal-status">
        <span className="is-muted">双击一行即可打开 · 共 {files.length} 个工作流，存在客户端数据目录的 workflows 下</span>
      </div>

      <div className="modal-actions">
        <button type="button" className="mini-btn is-default" onClick={onClose}>关闭</button>
      </div>
    </Dialog>
  );
}
