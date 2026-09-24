import {
  formatDialect,
  mysql,
  plsql,
  postgresql,
  sql,
  sqlite,
  type DialectOptions
} from "sql-formatter";

/* 连接类型 → 格式化方言：达梦语法接近 Oracle，用 plsql；Redis 不是 SQL，退化成通用方言 */
const DIALECTS: Record<string, DialectOptions> = {
  mysql,
  postgresql,
  sqlite,
  dm: plsql,
  redis: sql
};

/**
 * 按数据库类型格式化 SQL。
 * 在客户端本地完成（sql-formatter），不再走数据层。
 */
export function formatSql(query: string, dbType?: string): string {
  if (!query.trim())
    return query;

  return formatDialect(query, { dialect: (dbType && DIALECTS[dbType]) || sql });
}
