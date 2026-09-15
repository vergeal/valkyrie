import { Toaster } from "sonner";
import type { SavedConnection } from "../api";
import type { ExportProgress } from "../app/appTypes";
import type { AppSettings, ThemeMode } from "../settings";
import type { ConfirmDialogState, ConnectionDialogState, MessageBoxState, TextDialogState } from "../dialogs/useDialogs";
import { ConnectionDialog } from "./ConnectionDialog";
import { ConnectionManager } from "./ConnectionManager";
import { Dialog } from "./Dialog";
import { OptionsDialog } from "./OptionsDialog";
import { Icon } from "./icons";

/** App 层的全部对话框浮层 + 全局 Toaster。业务动作通过回调注入。 */
export function AppDialogs(props: {
  confirmDialog: ConfirmDialogState | null;
  answerConfirm: (confirmed: boolean) => void;
  connectionDialog: ConnectionDialogState | null;
  setConnectionDialog: (state: ConnectionDialogState | null) => void;
  onConnectionSaved: (name: string, options?: { connect?: boolean }) => void;
  managerOpen: boolean;
  setManagerOpen: (open: boolean) => void;
  connections: SavedConnection[];
  connectedName: string | null;
  onManagerOpen: (connection: SavedConnection) => void;
  onManagerEdit: (mode: "new" | "edit" | "copy", connection?: SavedConnection | null) => void;
  onManagerDelete: (connection: SavedConnection) => void;
  onManagerRefresh: () => void;
  optionsOpen: boolean;
  setOptionsOpen: (open: boolean) => void;
  settings: AppSettings;
  theme: ThemeMode;
  updateSettings: (patch: Partial<AppSettings>) => void;
  setTheme: (theme: ThemeMode) => void;
  exportProgress: ExportProgress | null;
  exportPercent: number | null;
  messageBox: MessageBoxState | null;
  setMessageBox: (state: MessageBoxState | null) => void;
  textDialog: TextDialogState | null;
  answerText: (value: string | null) => void;
}) {
  const {
    confirmDialog, answerConfirm,
    connectionDialog, setConnectionDialog, onConnectionSaved,
    managerOpen, setManagerOpen, connections, connectedName,
    onManagerOpen, onManagerEdit, onManagerDelete, onManagerRefresh,
    optionsOpen, setOptionsOpen, settings, theme, updateSettings, setTheme,
    exportProgress, exportPercent, messageBox, setMessageBox, textDialog, answerText
  } = props;

  return (
    <>
      {confirmDialog && (
        <Dialog title={confirmDialog.title} onClose={() => answerConfirm(false)}>
          <div className="modal-body">{confirmDialog.message}</div>
          <div className="modal-actions">
            <button type="button" className="mini-btn" onClick={() => answerConfirm(false)}>取消</button>
            <button
              type="button"
              className={`mini-btn${confirmDialog.danger ? " is-danger" : " is-default"}`}
              onClick={() => answerConfirm(true)}
            >
              确定
            </button>
          </div>
        </Dialog>
      )}

      {connectionDialog && (
        <ConnectionDialog
          mode={connectionDialog.mode}
          source={connectionDialog.connection}
          initialType={connectionDialog.initialType}
          onClose={() => setConnectionDialog(null)}
          onSaved={(name, options) => onConnectionSaved(name, options)}
        />
      )}

      {managerOpen && (
        <ConnectionManager
          connections={connections}
          connected={connectedName}
          onClose={() => setManagerOpen(false)}
          onOpen={connection => onManagerOpen(connection)}
          onEdit={(mode, connection) => onManagerEdit(mode, connection ?? null)}
          onDelete={connection => onManagerDelete(connection)}
          onRefresh={() => onManagerRefresh()}
        />
      )}

      {optionsOpen && (
        <OptionsDialog
          settings={settings}
          theme={theme}
          onChange={updateSettings}
          onThemeChange={setTheme}
          onClose={() => setOptionsOpen(false)}
        />
      )}

      {exportProgress && (
        <Dialog
          title={<><Icon name="download" size={14} />正在导出</>}
          className="export-progress-dialog"
          role="alertdialog"
        >
          <div className="export-progress">
            <div className={`export-progress-track${exportPercent === null ? " is-indeterminate" : ""}`}>
              <span
                className="export-progress-fill"
                style={exportPercent === null ? undefined : { width: `${exportPercent}%` }}
              />
            </div>
            <div className="export-progress-text">
              {exportProgress.phase === "count"
                ? `正在统计行数${exportProgress.table ? `（${exportProgress.table}）` : ""}…`
                : `已完成 ${exportProgress.current} / ${exportProgress.total} 张表 · 已写入 ${exportProgress.rows} 行`
                  + (exportProgress.totalRows > 0 ? ` / ${exportProgress.totalRows}` : "")}
            </div>
          </div>
        </Dialog>
      )}

      {messageBox && (
        <Dialog
          title={messageBox.title}
          role="alertdialog"
          onClose={() => setMessageBox(null)}
        >
          <div className="modal-body pre-wrap">{messageBox.message}</div>
          <div className="modal-actions">
            <button type="button" className="mini-btn is-default" onClick={() => setMessageBox(null)}>确定</button>
          </div>
        </Dialog>
      )}

      {textDialog && (
        <Dialog title={textDialog.title} onClose={() => answerText(null)}>
          <div className="modal-body">
            <input
              className="dialog-input"
              autoFocus
              defaultValue={textDialog.value}
              aria-label={textDialog.title}
              onKeyDown={event => {
                if (event.key === "Enter")
                  answerText((event.target as HTMLInputElement).value);
                else if (event.key === "Escape")
                  answerText(null);
              }}
              /* 打开即聚焦并全选默认值，改名时直接输入就能覆盖 */
              ref={input => {
                input?.focus();
                input?.select();
              }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="mini-btn" onClick={() => answerText(null)}>取消</button>
            <button
              type="button"
              className="mini-btn is-default"
              onClick={event => {
                const input = (event.currentTarget.closest(".modal") as HTMLElement)?.querySelector(".dialog-input") as HTMLInputElement | null;
                answerText(input?.value ?? null);
              }}
            >
              确定
            </button>
          </div>
        </Dialog>
      )}

      <Toaster
        position="bottom-right"
        theme={theme === "dark" ? "dark" : "light"}
        closeButton
        toastOptions={{ className: "vk-toast" }}
      />
    </>
  );
}
