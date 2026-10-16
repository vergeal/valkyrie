import type { SuggestionItem } from "../api";

/**
 * 内置的 SQL 关键字与常用函数。
 * <p>
 * 这些是「不管你连没连库、数据层快不快，敲下去就该有」的部分：补全弹窗先用它顶上，
 * 数据层返回的完整清单（含各产品自己的方言关键字、表名、字段）到了再合并，重复的以数据层为准。
 */
const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET", "DISTINCT",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "TRUNCATE", "MERGE",
  "CREATE", "ALTER", "DROP", "RENAME", "TABLE", "VIEW", "INDEX", "TRIGGER", "PROCEDURE", "FUNCTION",
  "DATABASE", "SCHEMA", "COLUMN", "CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "DEFAULT",
  "REFERENCES", "CASCADE", "RESTRICT", "AUTO_INCREMENT", "IDENTITY", "COMMENT",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON", "USING", "UNION", "ALL", "EXCEPT", "INTERSECT",
  "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "REGEXP", "CASE", "WHEN", "THEN", "ELSE", "END",
  "ASC", "DESC", "WITH", "RECURSIVE", "EXPLAIN", "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "SAVEPOINT", "GRANT", "REVOKE", "USE",
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "DECIMAL", "NUMERIC", "FLOAT", "DOUBLE", "REAL", "NUMBER",
  "CHAR", "VARCHAR", "VARCHAR2", "TEXT", "CLOB", "BLOB", "BINARY", "VARBINARY", "DATE", "TIME", "DATETIME", "TIMESTAMP", "BOOLEAN", "JSON", "UUID",
  "PARTITION", "TEMPORARY", "IF", "REPLACE", "CONVERT", "CAST", "INTERVAL", "EXTRACT", "ROWID", "DUAL"
];

const FUNCTIONS = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ABS", "CEIL", "CEILING", "FLOOR", "ROUND", "MOD", "POWER", "SQRT", "SIGN",
  "LENGTH", "CHAR_LENGTH", "SUBSTR", "SUBSTRING", "CONCAT", "TRIM", "LTRIM", "RTRIM", "UPPER", "LOWER", "REPLACE",
  "INSTR", "LPAD", "RPAD", "LEFT", "RIGHT", "REVERSE", "REPEAT",
  "NOW", "CURDATE", "CURTIME", "SYSDATE", "GETDATE", "DATEADD", "DATEDIFF", "DATE_FORMAT", "STR_TO_DATE",
  "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "TO_CHAR", "TO_DATE", "TO_NUMBER",
  "COALESCE", "NULLIF", "IFNULL", "NVL", "DECODE", "GREATEST", "LEAST",
  "ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE",
  "GROUP_CONCAT", "STRING_AGG", "LISTAGG", "WM_CONCAT", "JSON_EXTRACT", "JSON_VALUE", "JSON_OBJECT", "JSON_ARRAY"
];

/** 内置关键字 + 常用函数，按 label 去重 */
export const BUILTIN_SUGGESTIONS: SuggestionItem[] = [
  ...KEYWORDS.map(label => ({ label, kind: "Keyword", insertText: label })),
  ...FUNCTIONS.map(label => ({ label, kind: "Function", insertText: label }))
];

/** 光标前是不是一个「该写表名」的位置（FROM / JOIN / UPDATE / INTO …），用于就地给出表名 */
const TABLE_POSITION = /(^|[\s(,])(from|join|update|into|table|desc|describe)\s+[\w.`"[\]$]*$/i;

export function needsTableName(textBeforeCursor: string): boolean {
  return TABLE_POSITION.test(textBeforeCursor);
}
