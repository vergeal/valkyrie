import type { DataType } from "./types";

/** 通用表格结果：宿主把各数据库的结果集适配成这个形状 */
export interface TableResult {
  columns: { name: string; type: string }[];
  rows: (string | null)[][];
  rowCount: number;
  affected?: number;
}

export interface DatabaseService {
  open(connection: string): Promise<void>;
  close(connection: string): Promise<void>;
  isOpen(connection: string): boolean;
  query(connection: string, sql: string, params?: unknown[]): Promise<TableResult>;
  execute(connection: string, sql: string): Promise<TableResult>;
}

export interface SecretsService {
  get(name: string): Promise<string | undefined>;
}

export interface FileService {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  chooseOpen(options?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  chooseSave(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpService {
  request(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse>;
}

export interface NotifyOptions {
  title?: string;
  message: string;
  level?: "info" | "success" | "warning" | "error";
}

export interface NotifyService {
  notify(options: NotifyOptions): Promise<void>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerService {
  log(level: LogLevel, message: string): void;
}

export interface VariableStore {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  has(name: string): boolean;
  snapshot(): Record<string, unknown>;
}

export interface NodeServices {
  database: DatabaseService;
  secrets: SecretsService;
  files: FileService;
  http: HttpService;
  notify: NotifyService;
  logger: LoggerService;
  variables: VariableStore;
}

export interface ServiceMap {
  [key: string]: unknown;
}

export function dataTypeMatches(expected: DataType | undefined, value: unknown): boolean {
  if (!expected || expected === "any")
    return true;

  if (value == null)
    return true;

  switch (expected) {
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "decimal":
      return typeof value === "number";
    case "string":
    case "secret":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string" || typeof value === "number" || value instanceof Date;
    case "array":
    case "table":
      return Array.isArray(value);
    case "object":
    case "connection":
    case "database":
      return typeof value === "object";
    default:
      return true;
  }
}
