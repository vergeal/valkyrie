import type { SchemaNode } from "../api";
import type { SessionState, WorkTab } from "../app/appTypes";
import type { AppSettings } from "../settings";

/**
 * 表数据 / 表设计两个 Hook 共用的依赖（由 App 组装后注入）。
 */
export interface TableContext {
  settings: AppSettings;
  tabs: WorkTab[];
  setTabs: (updater: WorkTab[] | ((previous: WorkTab[]) => WorkTab[])) => void;
  setActiveTabId: (id: string) => void;
  updateTab: (id: string, patch: Partial<WorkTab>) => void;
  sessionOfNode: (node: SchemaNode | null | undefined, tab?: WorkTab | null) => SessionState | null;
  connectionOfNode: (node: SchemaNode | null | undefined) => string | undefined;
  askConfirm: (message: string, title?: string, danger?: boolean) => Promise<boolean>;
  withBusy: <T>(action: () => Promise<T>) => Promise<T>;
  setPending: (value: string | null) => void;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  flash: (text: string) => void;
  refreshObjectList: (node: SchemaNode) => void;
  activeNode: SchemaNode | null;
  session: SessionState | null;
  copyText: (text: string) => Promise<void>;
  setTableSelection: (names: string[]) => void;
}
