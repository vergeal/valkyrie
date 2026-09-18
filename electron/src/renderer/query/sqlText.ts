/** SQL 文本层面的小工具：判定查询语句、按数据库类型生成 EXPLAIN 前缀。 */

/** 能返回结果集的语句首关键字（与数据层 SQLParsedStatement.isQueryLike 保持一致） */
const QUERY_LEADERS = new Set(["select", "show", "desc", "describe", "explain", "pragma", "with", "values", "table"]);

/**
 * 取 SQL 的首关键字：先剥掉前导的行注释 / 块注释与空白，再匹配第一个单词。
 * 解析失败时返回空串，调用方按「非查询」处理。
 */
export function leadingKeyword(sql: string): string {
  const stripped = sql
    .replace(/^\s*(?:(?:--|#)[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, "")
    .trim();
  const match = stripped.match(/^([a-zA-Z]+)/);

  return match ? match[1].toLowerCase() : "";
}

/** 是否为查询语句（可执行 EXPLAIN 的语句）：SELECT / SHOW / WITH / PRAGMA 等。 */
export function isQuerySql(sql: string): boolean {
  return QUERY_LEADERS.has(leadingKeyword(sql));
}

/**
 * 生成执行计划语句。SQLite 需要 EXPLAIN QUERY PLAN 才是可读的查询计划，
 * 其余数据库统一用 EXPLAIN（不加 ANALYZE，避免真正执行语句产生副作用）。
 */
export function explainStatement(sql: string, dbType?: string): string {
  const cleaned = sql.replace(/;\s*$/, "");
  const type = (dbType ?? "").toLowerCase();

  if (type === "sqlite")
    return `EXPLAIN QUERY PLAN ${cleaned}`;

  return `EXPLAIN ${cleaned}`;
}
