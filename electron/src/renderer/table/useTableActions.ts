import type { SavedConnection } from "../api";
import type { QueryTab, SessionState, WorkTab } from "../app/appTypes";
import { KEY } from "../keys";
import { createTableTemplate } from "./tableHelpers";

export interface TableActionsDeps {
  session: SessionState | null;
  connections: SavedConnection[];
  askText: (title: string, value?: string) => Promise<string | null>;
  openQueryTab: () => Promise<QueryTab | undefined>;
  updateTab: (id: string, patch: Partial<WorkTab>) => void;
  scriptCatalog: () => string;
  setError: (message: string | null) => void;
  setStatus: (message: string) => void;
}

/**
 * 表相关的独立动作：新建表草稿（按当前连接类型生成模板放进查询控制台）。
 */
export function useTableActions(deps: TableActionsDeps) {
  const { session, connections, askText, openQueryTab, updateTab, scriptCatalog, setError, setStatus } = deps;

  /**
   * 新建表：按当前连接的类型生成一份建表草稿放进查询控制台，
   * 由用户确认 / 补全后再执行 —— 各数据库的建表语法差异很大，
   * 与其替用户猜，不如给一份能直接改的模板。
   */
  async function createTableDraft(catalogHint?: string) {
    if (!session) {
      setError("请先在左侧选择一个连接");
      return;
    }

    const name = await askText("新建表（生成建表草稿）", "new_table");

    if (!name)
      return;

    const type = (session.product.type ?? connections.find(item => item.name === session.name)?.type ?? "mysql").toLowerCase();
    const catalog = catalogHint ?? scriptCatalog();
    const tab = await openQueryTab();

    if (!tab)
      return;

    updateTab(tab.id, {
      title: `新建表 ${name}`,
      sql: createTableTemplate(name, type),
      path: { ...tab.path, catalog }
    });
    setStatus(`已生成建表草稿，确认无误后按 ${KEY.run} 执行`);
  }

  return { createTableDraft };
}
