import type { ProductMeta, QueryResultPayload, SavedConnection, SchemaNode, ScriptFile, TableColumn, TableIndex } from "../api";
import type { LogRecord } from "../ui/LogConsole";

/** 已打开连接的活动会话 */
export interface SessionState {
  sessionId: string;
  name: string;
  product: ProductMeta;
}

export interface BaseTab {
  id: string;
  title: string;
  running: boolean;
  messages: string[];
  /** 执行日志（按标签隔离：每个控制台各看各的） */
  logs?: LogRecord[];
  /** 最近一次执行的耗时（按标签隔离） */
  lastCost?: number | null;
  /** 本次未提交的改动条数（编辑/新增/删除/设 NULL 累计），提交/回滚后清零 */
  pending?: number;
}

export interface QueryTab extends BaseTab {
  kind: "query";
  sql: string;
  /** 上次保存到磁盘的内容；与 sql 不一致说明有未保存修改 */
  savedSql?: string;
  result: QueryResultPayload | null;
  plan: QueryResultPayload | null;
  /** 生成当前执行计划所用的 SQL（分析时引用原始语句） */
  planSql?: string;
  /** 生成执行计划时连接的数据类型（按库解析计划格式） */
  planDbType?: string;
  dirtyRows: number[];
  /* 绑定到本地查询脚本文件时才有 */
  script?: { connection: string; catalog: string; name: string };
  /* 执行上下文：连接 → 数据库 → 模式 → 表 */
  path: { connection?: string; catalog?: string; schema?: string; table?: string };
}

export interface DataTab extends BaseTab {
  kind: "data";
  /** 这个数据页属于哪个连接（多连接并存时各自用各自的会话） */
  connection?: string;
  node: SchemaNode;
  result: QueryResultPayload | null;
  dirtyRows: number[];
  page: number;
  pageSize: number;
}

export interface DesignTab extends BaseTab {
  kind: "design";
  connection?: string;
  node: SchemaNode;
  columns: TableColumn[];
  indexes: TableIndex[];
  ddl: string;
  loading: boolean;
}

/**
 * 「对象」列：属于当前连接的一个固定页面，内容跟着对象树的选中项走 ——
 * 选中库 / 表 → 数据表列表，选中脚本 → 脚本列表；断开连接时一起关闭。
 */
export interface ObjectTabTables extends BaseTab {
  kind: "objects";
  view: "tables";
  /** 表列表所属连接 */
  connection?: string;
  /* 数据表列表所属的「数据表」容器节点 */
  node: SchemaNode;
  tables: SchemaNode[];
  scripts: ScriptFile[];
  loading: boolean;
}

export interface ObjectTabScripts extends BaseTab {
  kind: "objects";
  view: "scripts";
  /** 脚本列表也按连接归属，关连接时一起收走 */
  connection?: string;
  node: null;
  tables: SchemaNode[];
  scripts: ScriptFile[];
  loading: boolean;
}

export type ObjectTab = ObjectTabTables | ObjectTabScripts;

export type WorkTab = QueryTab | DataTab | DesignTab | ObjectTab;

export type ResultPane = "grid" | "msg" | "plan" | "log";

/** 导出进度：后端按表 / 分页上报，进度条弹窗据此显示 */
export interface ExportProgress {
  token: string;
  current: number;
  total: number;
  totalRows: number;
  rows: number;
  table?: string;
  phase?: string;
}

/** 对象树：当前选中的表 / 脚本等 */
export type ConnectionList = SavedConnection[];

export interface ObjectTarget {
  view: "tables" | "scripts";
  node: SchemaNode | null;
}
