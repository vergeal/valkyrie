/** 连接 / 数据库 / 模式句柄：在数据线上传递的上下文对象 */

export interface ConnectionHandle {
  connection: string;
}

export interface DatabaseHandle {
  connection: string;
  catalog?: string;
}

export interface SchemaHandle {
  connection: string;
  catalog?: string;
  schema?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 从句柄里取连接名（兼容直接传连接名字符串） */
export function connectionNameOf(value: unknown): string | undefined {
  if (typeof value === "string")
    return nonEmpty(value);

  return nonEmpty(asRecord(value)?.connection);
}

export function catalogOf(value: unknown): string | undefined {
  return nonEmpty(asRecord(value)?.catalog);
}

export function schemaOf(value: unknown): string | undefined {
  return nonEmpty(asRecord(value)?.schema);
}
