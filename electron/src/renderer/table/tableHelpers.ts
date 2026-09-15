import type { SchemaNode } from "../api";
import type { DesignTab } from "../app/appTypes";
import type { DesignColumn, DesignIndex } from "../ui/TableDesign";

export function tableParams(sessionId: string, node: SchemaNode): Record<string, unknown> {
  return {
    sessionId,
    table: node.table?.name ?? node.label,
    catalog: node.catalog,
    schema: node.schema
  };
}

/** 按数据库类型生成建表草稿（只是模板，用户可随意改） */
export function createTableTemplate(name: string, type: string): string {
  switch (type) {
    case "postgresql":
      return `CREATE TABLE ${name} (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(64) NOT NULL\n);\n`;
    case "sqlite":
      return `CREATE TABLE ${name} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name VARCHAR(64) NOT NULL\n);\n`;
    case "dm":
      return `CREATE TABLE ${name} (\n  id INT IDENTITY(1, 1) PRIMARY KEY,\n  name VARCHAR(64) NOT NULL\n);\n`;
    case "redis":
      return `-- Redis 没有建表语句，这里按键值对思路写两句备注：\n-- SET ${name}:1 "value"\n-- HSET ${name}:1 field "value"\n`;
    default:
      return `CREATE TABLE \`${name}\` (\n  \`id\` INT NOT NULL AUTO_INCREMENT,\n  \`name\` VARCHAR(64) NOT NULL,\n  PRIMARY KEY (\`id\`)\n);\n`;
  }
}

/** 把「这次保存会改什么」列成清单：删除类改动要单独点名（确认框里必须说清楚） */
export function describeDesignChanges(
  tab: DesignTab | undefined, columns: DesignColumn[], indexes: DesignIndex[]
): string[] {
  const lines: string[] = [];
  const existingColumns = new Map((tab?.columns ?? []).map(column => [column.name, column]));
  const keptColumns = new Set<string>();

  for (const column of columns) {
    const before = existingColumns.get(column.originalName ?? column.name);

    if (!before) {
      lines.push(`· 新增字段 ${column.name}${column.type ? ` ${column.type}` : ""}`);
      continue;
    }

    keptColumns.add(before.name);

    const changes: string[] = [];

    if (before.name !== column.name)
      changes.push(`改名为 ${column.name}`);

    if ((before.type ?? "") !== column.type)
      changes.push(`类型 ${before.type ?? "（空）"} → ${column.type || "（空）"}`);

    if (Boolean(before.notNull) !== column.notNull)
      changes.push(column.notNull ? "改为非空" : "改为可空");

    if (Boolean(before.autoIncrement) !== column.autoIncrement)
      changes.push(column.autoIncrement ? "加上自增" : "去掉自增");

    if ((before.defaultValue ?? "") !== (column.defaultValue ?? ""))
      changes.push(`默认值 → ${column.defaultValue || "NULL"}`);

    if ((before.comment ?? "") !== (column.comment ?? ""))
      changes.push(`注释 → ${column.comment || "（清空）"}`);

    if (changes.length > 0)
      lines.push(`· 修改字段 ${before.name}：${changes.join("，")}`);
  }

  for (const column of tab?.columns ?? [])
    if (!keptColumns.has(column.name))
      lines.push(`· 删除字段 ${column.name}（字段里的数据会一起丢失）`);

  const primaryBefore = (tab?.columns ?? []).filter(column => column.primary).map(column => column.name);
  const primaryAfter = columns.filter(column => column.primary).map(column => column.name);

  if (primaryBefore.join(",") !== primaryAfter.join(","))
    lines.push(`· 主键：${primaryBefore.join("+") || "（无）"} → ${primaryAfter.join("+") || "（无）"}`);

  const existingIndexes = new Map((tab?.indexes ?? []).map(index => [index.name, index]));
  const keptIndexes = new Set<string>();

  for (const index of indexes) {
    const before = existingIndexes.get(index.originalName ?? index.name);

    if (!before) {
      lines.push(`· 新增索引 ${index.name}（${index.columnsText || ""}）`);
      continue;
    }

    keptIndexes.add(before.name);

    const changes: string[] = [];

    if (before.name !== index.name)
      changes.push(`改名为 ${index.name}`);

    if ((before.columnsText ?? "") !== (index.columnsText ?? ""))
      changes.push(`字段 ${before.columnsText ?? ""} → ${index.columnsText ?? ""}`);

    if ((before.type ?? "") !== (index.type ?? ""))
      changes.push(`类型 ${before.type ?? ""} → ${index.type ?? ""}`);

    if (Boolean(before.visible) !== index.visible)
      changes.push(index.visible ? "改为可见" : "改为不可见");

    if (changes.length > 0)
      lines.push(`· 修改索引 ${before.name}：${changes.join("，")}`);
  }

  for (const index of tab?.indexes ?? [])
    if (!keptIndexes.has(index.name))
      lines.push(`· 删除索引 ${index.name}`);

  return lines;
}
