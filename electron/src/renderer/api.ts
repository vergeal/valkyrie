/**
 * 渲染层与数据层之间的类型化调用封装。
 * 所有数据库操作都通过 Electron 主进程转发给 Java 数据层，渲染层不直接访问数据库。
 */

export interface SavedConnection {
  name: string;
  type: string;
  host?: string;
  port?: string;
  db?: string;
  username?: string;
  password?: string;
  savePassword?: boolean;
  jdbcUrl?: string;
  timezone?: string;
  useSSL?: boolean;
  tinyint1isBit?: boolean;
  sqlitePath?: string;
}

export interface TableMeta {
  name: string;
  engine?: string;
  rows?: number;
  /** 数据大小（字节），展示时用 formatByteSize 换算 */
  size?: number;
  comment?: string;
  createTime?: number;
  updateTime?: number;
}

/** 本地查询脚本文件（脚本对象页用） */
export interface ScriptFile {
  name: string;
  path: string;
  /** 所属数据库目录 */
  catalog: string;
  /** 所属连接（列表接口逐条补齐，用于按连接打开） */
  connection?: string;
  size: number;
  modified: number;
}

export type NodeKind = "ROOT" | "CONNECTION" | "CATALOG" | "SCHEMA" | "TABLE" | "VIEW" | "TRIGGER" | "COLUMN" | "INDEX" | "FOREIGN_KEY" | "QUERY";

/** 表字段（「字段」分类下的子节点） */
export interface ColumnMeta {
  name: string;
  type?: string;
  notNull?: boolean;
  primary?: boolean;
  autoIncrement?: boolean;
  defaultValue?: string;
  comment?: string;
}

/** 表索引（「索引」分类下的子节点） */
export interface IndexMeta {
  name: string;
  columnsText?: string;
  type?: string;
  visible?: boolean;
}

/** 表外键（「外键」分类下的子节点） */
export interface ForeignKeyMeta {
  name: string;
  columnsText?: string;
  refTable?: string;
  refColumnsText?: string;
}

export interface SchemaNode {
  id: string;
  label: string;
  kind: NodeKind;
  icon?: string;
  hasChildren: boolean;
  catalog?: string;
  schema?: string;
  table?: TableMeta;
  column?: ColumnMeta;
  index?: IndexMeta;
  foreignKey?: ForeignKeyMeta;
  connected?: boolean;
  badge?: string;
  /** 连接节点带上对应的数据库类型，用于显示品牌 logo */
  dbType?: string;
  path?: string;
  size?: number;
  modified?: number;
}

export interface ProductMeta {
  productName?: string;
  version?: string;
  majorVersion?: number;
  minorVersion?: number;
  type?: string;
}

export interface QueryColumn {
  label: string;
  name: string;
  type: string;
  primary: boolean;
  notNull: boolean;
  autoIncrement: boolean;
  comment?: string;
  defaultValue?: string;
}

export interface TableColumn extends QueryColumn {
  index?: number;
}

export interface TableIndex {
  name: string;
  columnsText?: string;
  type?: string;
  visible?: boolean;
}

export interface SuggestionItem {
  label: string;
  kind: string;
  insertText?: string;
  detail?: string;
}

export interface QueryResultPayload {
  jobId?: number;
  hasResultSet: boolean;
  columns?: QueryColumn[];
  rows?: (string | null)[][];
  editable?: boolean;
  addable?: boolean;
  dirty?: boolean;
  /** 待删除但还没提交的行下标（提交后才真正消失） */
  deletedRows?: number[];
  offset?: number;
  size?: number;
}

export interface OpenConnectionPayload {
  sessionId: string;
  product: ProductMeta;
  nodes: SchemaNode[];
}

export interface ProgressEvent {
  channel: string;
  sessionId?: string;
  jobId?: number;
  kind?: string;
  detail?: string;
  pid?: number;
  javaVersion?: string;
}

interface InvokeResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

/** 系统原生消息框参数（错误提示等） */
export interface MessageOptions {
  type?: "none" | "info" | "error" | "question" | "warning";
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
}

/** 系统原生菜单项：与 Electron MenuItem 对齐的最小集合 */
export interface NativeMenuItem {
  id?: string;
  label?: string;
  type?: "separator";
  enabled?: boolean;
  /** 快捷键提示（Electron accelerator 写法），系统会右对齐显示 */
  accelerator?: string;
  /** PNG data URL（系统菜单只吃位图） */
  icon?: string;
  /** 二级菜单 */
  submenu?: NativeMenuItem[];
}

declare global {
  interface Window {
    valkyrie?: {
      /** 运行平台：darwin / win32 / linux */
      platform?: string;
      invoke: (method: string, params?: Record<string, unknown>) => Promise<InvokeResponse<unknown>>;
      onEvent: (callback: (params: ProgressEvent) => void) => () => void;
      windowControl?: (action: "minimize" | "maximize" | "close") => void;
      onWindowState?: (callback: (state: { maximized: boolean }) => void) => () => void;
      onShortcut?: (callback: (action: string) => void) => () => void;
      chooseSavePath?: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      chooseOpenPath?: (options: { title?: string; defaultPath?: string; directory?: boolean; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      revealPath?: (target: string) => Promise<boolean>;
      showMessage?: (options: MessageOptions) => Promise<number>;
      showMenu?: (options: { items: NativeMenuItem[] }) => Promise<string | null>;
      setNativeTheme?: (theme: string) => Promise<boolean>;
      /** macOS 系统菜单栏：整份菜单同步到主进程 */
      setAppMenu?: (items: NativeMenuItem[]) => Promise<boolean>;
      /** 系统菜单栏被点中的项（回传菜单项 id） */
      onAppMenu?: (callback: (id: string) => void) => () => void;
      /** 客户端设置：主进程负责写 userData/settings.json */
      loadSettings?: () => Promise<Record<string, unknown>>;
      saveSettings?: (settings: Record<string, unknown>) => Promise<boolean>;
      /** 本机字体族列表 */
      listFonts?: () => Promise<string[]>;
    };
  }
}

export async function invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  if (!window.valkyrie)
    throw new Error("未检测到数据层通道，请在 Electron 客户端中运行");

  const response = await window.valkyrie.invoke(method, params);

  if (!response.ok)
    throw new Error(response.error || "数据层调用失败");

  return response.result as T;
}

export function onEvent(callback: (params: ProgressEvent) => void): () => void {
  if (!window.valkyrie)
    return () => undefined;

  return window.valkyrie.onEvent(callback);
}

export function windowControl(action: "minimize" | "maximize" | "close"): void {
  window.valkyrie?.windowControl?.(action);
}

export function onWindowState(callback: (state: { maximized: boolean }) => void): () => void {
  return window.valkyrie?.onWindowState?.(callback) ?? (() => undefined);
}

/** 订阅原生菜单转发过来的快捷键（目前只有 macOS 的 ⌘A） */
export function onShortcut(callback: (action: string) => void): () => void {
  return window.valkyrie?.onShortcut?.(callback) ?? (() => undefined);
}

export function chooseSavePath(options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
  return window.valkyrie?.chooseSavePath?.(options) ?? Promise.resolve(null);
}

/** 弹系统"打开文件/选择目录"对话框（SQLite 文件、脚本导入等） */
export function chooseOpenPath(options: { title?: string; defaultPath?: string; directory?: boolean; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
  return window.valkyrie?.chooseOpenPath?.(options) ?? Promise.resolve(null);
}

export function revealPath(target: string): Promise<boolean> {
  return window.valkyrie?.revealPath?.(target) ?? Promise.resolve(false);
}

/** 弹系统原生消息框（返回按钮下标） */
export function showMessage(options: MessageOptions): Promise<number> {
  return window.valkyrie?.showMessage?.(options) ?? Promise.resolve(0);
}

/** 弹系统原生右键菜单（在当前鼠标位置；返回被选中项 id，未选中为 null） */
export function showMenu(items: NativeMenuItem[]): Promise<string | null> {
  return window.valkyrie?.showMenu?.({ items }) ?? Promise.resolve(null);
}

/** 让原生菜单 / 系统对话框跟随应用主题 */
export function setNativeTheme(theme: string): Promise<boolean> {
  return window.valkyrie?.setNativeTheme?.(theme) ?? Promise.resolve(false);
}

/** macOS 系统菜单栏：把整份菜单同步到主进程（窗口内不再自绘菜单栏） */
export function setAppMenu(items: NativeMenuItem[]): Promise<boolean> {
  return window.valkyrie?.setAppMenu?.(items) ?? Promise.resolve(false);
}

/** 订阅系统菜单栏被点中的项（回传菜单项 id） */
export function onAppMenu(callback: (id: string) => void): () => void {
  return window.valkyrie?.onAppMenu?.(callback) ?? (() => undefined);
}

/** 从主进程读客户端设置（userData/settings.json） */
export function loadSettingsFile(): Promise<Record<string, unknown>> {
  return window.valkyrie?.loadSettings?.() ?? Promise.resolve({});
}

/** 把客户端设置写回主进程的配置文件 */
export function saveSettingsFile(settings: Record<string, unknown>): Promise<boolean> {
  return window.valkyrie?.saveSettings?.(settings) ?? Promise.resolve(false);
}

/** 枚举本机字体族（由主进程用各平台系统接口拿，Chromium 未暴露 Local Font Access） */
export function listFonts(): Promise<string[]> {
  return window.valkyrie?.listFonts?.() ?? Promise.resolve([]);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNumericType(type: string | undefined): boolean {
  return Boolean(type) && /(int|decimal|numeric|float|double|real|money|number)/i.test(type as string);
}
