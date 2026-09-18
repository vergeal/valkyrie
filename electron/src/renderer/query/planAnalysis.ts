import type { QueryColumn, QueryResultPayload } from "../api";

/** 分析结论的严重程度：提示 / 警告 / 风险 */
export type PlanLevel = "info" | "warn" | "risk";

/** 一条执行计划分析结论 */
export interface PlanFinding {
  level: PlanLevel;
  title: string;
  detail?: string;
}

/** 一条 SQL 优化建议（可带可直接执行的 SQL） */
export interface PlanSuggestion {
  title: string;
  detail?: string;
  sql?: string;
}

export interface PlanAnalysis {
  /** 面向用户的一句话总览 */
  summary: string;
  findings: PlanFinding[];
  suggestions: PlanSuggestion[];
}

const EMPTY_ANALYSIS: PlanAnalysis = {
  summary: "暂无执行计划数据",
  findings: [],
  suggestions: []
};

/** 各数据库类型下可能出现的类型名：出现在等号左侧时不是列名 */
const TYPE_WORDS = new Set([
  "text", "integer", "int", "int2", "int4", "int8", "bigint", "smallint", "boolean", "bool",
  "numeric", "decimal", "double", "real", "float", "timestamp", "timestamptz", "date", "time",
  "varchar", "character", "varying", "char", "json", "jsonb", "uuid", "blob", "bytea", "money"
]);

/** 标识符安全化：索引名里只保留字母数字下划线 */
function safeName(value: string): string {
  return value.replace(/[^\w]/g, "_").replace(/^_+|_+$/g, "") || "col";
}

/** 按列名 / 标签取单元格（大小写不敏感） */
function cell(row: (string | null)[], columns: QueryColumn[], ...names: string[]): string {
  for (const name of names) {
    const index = columns.findIndex(column =>
      (column.name ?? "").toLowerCase() === name || (column.label ?? "").toLowerCase() === name);

    if (index >= 0)
      return row[index] ?? "";
  }

  return "";
}

type Analyzer = (
  plan: QueryResultPayload,
  sql: string,
  findings: PlanFinding[],
  suggestions: PlanSuggestion[]
) => void;

/**
 * 从条件表达式里粗略提取参与比较的列名：先剥掉 ::type 转义与字符串字面量，
 * 再匹配「标识符 + 比较符」。命中不了就返回空数组，调用方降级为纯文字建议。
 */
function extractConditionColumns(expression: string): string[] {
  const cleaned = expression
    .replace(/::[a-zA-Z_][a-zA-Z0-9_]*(\[\])?/g, "")
    .replace(/'[^']*'/g, "?")
    .replace(/[()]/g, " ");
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|<>|!=|<=|>=|<|>)/g;
  const columns: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cleaned)) !== null) {
    const name = match[1];

    if (!TYPE_WORDS.has(name.toLowerCase()))
      columns.push(name);
  }

  return [...new Set(columns)];
}

/** 从整条 SQL 的 WHERE / JOIN ON 条件里提列，作为无更精确线索时的兜底 */
function columnsFromSql(sql: string): string[] {
  const where = sql.match(/\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/i);
  const on = [...sql.matchAll(/\bon\b([\s\S]*?)(?:\bjoin\b|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/gi)]
    .map(match => match[1]);
  const parts = [...(where ? [where[1]] : []), ...on];

  return [...new Set(parts.flatMap(part => extractConditionColumns(part)))];
}

/** MySQL：EXPLAIN 结果为「每张表一行」的访问方式 */
const analyzeMysql: Analyzer = (plan, sql, findings, suggestions) => {
  const columns = plan.columns ?? [];
  const rows = plan.rows ?? [];
  const fallbackColumns = columnsFromSql(sql);

  for (const row of rows) {
    const table = cell(row, columns, "table");
    const access = cell(row, columns, "type").toLowerCase();
    const key = cell(row, columns, "key");
    const possible = cell(row, columns, "possible_keys");
    const extra = cell(row, columns, "extra").toLowerCase();
    const estimated = Number(cell(row, columns, "rows") || "0");
    const label = table || "结果集";
    const scanned = estimated > 0 ? `预估扫描 ${estimated.toLocaleString()} 行` : "未使用索引，逐行扫描整张表";

    if (access === "all") {
      findings.push({ level: "warn", title: `全表扫描：${label}`, detail: scanned });

      if (possible)
        suggestions.push({
          title: `检查 ${label} 的索引选择`,
          detail: `possible_keys=${possible}，实际未选用任何索引；确认过滤条件写法或评估 FORCE INDEX`
        });
      else
        suggestions.push({
          title: `为 ${label} 建立索引`,
          detail: "把 WHERE / JOIN 条件列建成索引，可避免全表扫描",
          sql: fallbackColumns.length
            ? `CREATE INDEX idx_${safeName(label)}_${safeName(fallbackColumns[0])} ON ${label} (${fallbackColumns.join(", ")});`
            : undefined
        });
    } else if (access === "index") {
      findings.push({ level: "info", title: `全索引扫描：${label}`, detail: "扫描整棵索引树，优于全表扫描但仍需读全部索引项" });
    } else if (access === "range") {
      findings.push({ level: "info", title: `范围扫描：${label}`, detail: `使用索引 ${key || "-"} 按范围读取` });
    } else if (["ref", "eq_ref", "const", "system", "index_merge", "fulltext", "ref_or_null"].includes(access)) {
      findings.push({ level: "info", title: `索引访问：${label}`, detail: `访问方式 ${access.toUpperCase()}，索引 ${key || "-"}` });
    }

    if (!key && possible)
      findings.push({ level: "warn", title: `可用索引未命中：${label}`, detail: `possible_keys=${possible}，实际 key 为空` });

    if (extra.includes("using filesort"))
      findings.push({ level: "warn", title: `文件排序：${label}`, detail: "ORDER BY / GROUP BY 未走索引，需要额外排序" });

    if (extra.includes("using temporary"))
      findings.push({ level: "warn", title: `使用临时表：${label}`, detail: "常见于 GROUP BY / DISTINCT / UNION，可尝试补索引或改写" });

    if (extra.includes("using join buffer"))
      findings.push({ level: "warn", title: `连接缓冲：${label}`, detail: "被驱动表缺少可用索引，退化为块嵌套循环" });

    if (estimated >= 10000 && access !== "const" && access !== "system")
      findings.push({ level: "warn", title: `预估扫描行数偏大：${label}`, detail: `rows=${estimated.toLocaleString()}，建议缩小过滤范围或补索引` });
  }
};

/** 向下查找缩进更深的子行，匹配正则后返回捕获组（PostgreSQL 文本计划树） */
function findPlannedChild(lines: string[], from: number, pattern: RegExp): string | null {
  const baseIndent = lines[from].length - lines[from].trimStart().length;

  for (let i = from + 1; i < lines.length; i++) {
    const indent = lines[i].length - lines[i].trimStart().length;

    if (lines[i].trim() && indent <= baseIndent)
      break;

    const match = lines[i].trim().match(pattern);

    if (match)
      return match[1] ?? "";
  }

  return null;
}

/** PostgreSQL：EXPLAIN 结果是一棵缩进文本的计划树 */
const analyzePostgresql: Analyzer = (plan, sql, findings, suggestions) => {
  const lines = (plan.rows ?? []).map(row => row[0] ?? "");
  const text = lines.join("\n");
  const fallbackColumns = columnsFromSql(sql);
  const totalCost = Number(text.match(/cost=[\d.]+\.\.([\d.]+)/)?.[1] ?? "0");

  lines.forEach((line, index) => {
    const raw = line.trim();
    /* 计划树节点行以 "->" 前缀标记，匹配前先剥掉 */
    const node = raw.replace(/^->\s*/, "");
    const seq = node.match(/^Seq Scan on (\S+)/i);

    if (seq) {
      const table = seq[1];
      const filter = findPlannedChild(lines, index, /^Filter:\s*(.+)$/i);
      const columns = filter ? extractConditionColumns(filter) : [];
      const used = columns.length ? columns : fallbackColumns;

      findings.push({ level: "warn", title: `顺序扫描（全表）：${table}`, detail: filter ? `过滤条件：${filter}` : "未使用索引，逐行扫描整张表" });
      suggestions.push({
        title: `为 ${table} 建立索引`,
        detail: columns.length ? "对过滤列建索引可转为索引扫描" : "若表数据量大，建议为过滤 / 连接列建索引",
        sql: used.length
          ? `CREATE INDEX idx_${safeName(table)}_${safeName(used[0])} ON ${table} (${used.join(", ")});`
          : undefined
      });
    } else if (/^Index (Only )?Scan using (\S+) on (\S+)/i.test(node)) {
      const match = node.match(/^Index (Only )?Scan using (\S+) on (\S+)/i)!;
      findings.push({ level: "info", title: `索引扫描：${match[3]}`, detail: `使用索引 ${match[2]}` });
    } else if (/^Bitmap (Index|Heap) Scan/i.test(node)) {
      findings.push({ level: "info", title: "位图扫描", detail: node });
    } else if (/^Sort\b/i.test(node)) {
      findings.push({ level: /external merge/i.test(node) ? "risk" : "warn", title: "排序操作", detail: node });
      suggestions.push({ title: "减少排序开销", detail: "为 ORDER BY / GROUP BY 列建立有序索引可消除排序步骤" });
    } else if (/^Nested Loop\b/i.test(node)) {
      findings.push({ level: "info", title: "嵌套循环连接", detail: "驱动表行数很大时注意内层是否走索引" });
    } else if (/Rows Removed by Filter:\s*(\d+)/i.test(node)) {
      findings.push({ level: "warn", title: "过滤淘汰大量行", detail: node });
    }
  });

  if (totalCost >= 10000)
    findings.push({ level: "warn", title: "计划总代价偏高", detail: `总成本 ${totalCost.toLocaleString()}，建议复核索引与查询写法` });
};

/** SQLite：EXPLAIN QUERY PLAN 每行是一步，detail 里是 SCAN / SEARCH 描述 */
const analyzeSqlite: Analyzer = (plan, sql, findings, suggestions) => {
  const columns = plan.columns ?? [];
  const rows = plan.rows ?? [];
  const fallbackColumns = columnsFromSql(sql);

  for (const row of rows) {
    const detail = cell(row, columns, "detail");
    const lower = detail.toLowerCase();
    const table = detail.match(/(?:scan|search)\s+(\S+)/i)?.[1] ?? "结果集";

    if (/\buse temp b-tree\b/.test(lower)) {
      findings.push({ level: "warn", title: lower.includes("order by") ? "临时排序" : "临时索引结构", detail });
    } else if (/\bscan\b/.test(lower)) {
      const covering = /using covering index/i.test(detail);
      const usingIndex = /using (covering )?index/i.test(detail);

      /* 走索引的扫描（含覆盖索引）与真正的全表扫描分开，避免误报 */
      if (usingIndex) {
        findings.push({ level: "info", title: covering ? `覆盖索引扫描：${table}` : `索引扫描：${table}`, detail });
      } else {
        findings.push({ level: "warn", title: `全表扫描：${table}`, detail });

        const parsed = extractConditionColumns(detail);
        const used = parsed.length ? parsed : fallbackColumns;

        suggestions.push({
          title: `为 ${table} 建立索引`,
          detail: "为 WHERE / JOIN / ORDER BY 列建索引，可把全表扫描转为索引查找",
          sql: used.length
            ? `CREATE INDEX idx_${safeName(table)}_${safeName(used[0])} ON ${table} (${used.join(", ")});`
            : undefined
        });
      }
    } else if (/\bsearch\b/.test(lower)) {
      findings.push({ level: "info", title: `索引查找：${table}`, detail });
    } else if (/\bmulti-index or\b/.test(lower)) {
      findings.push({ level: "info", title: "多索引 OR 优化", detail });
    }
  }
};

/** 达梦 / 未知类型：没有稳定的列结构，退化为关键词扫描 */
const analyzeGeneric: Analyzer = (plan, _sql, findings, suggestions) => {
  const text = (plan.rows ?? []).map(row => row.map(value => value ?? "").join(" ")).join("\n");
  const lower = text.toLowerCase();

  if (/(seq scan|table scan|full scan|table access full|全表扫描)/.test(lower))
    findings.push({ level: "warn", title: "检测到全表扫描", detail: "执行计划中存在全表 / 顺序扫描" });

  if (/(using filesort|use temp b-tree for order|external merge)/.test(lower))
    findings.push({ level: "warn", title: "检测到外部排序", detail: "查询需要额外排序，可考虑为排序 / 过滤列建索引" });

  if (/using temporary|temp b-tree for group/.test(lower))
    findings.push({ level: "warn", title: "检测到临时表", detail: "GROUP BY / DISTINCT 等引入了临时结构" });

  if (findings.length > 0)
    suggestions.push({ title: "补充索引与条件", detail: "按计划里扫描的对象，检查 WHERE / JOIN / ORDER BY 列并建立合适索引" });
};

const ANALYZERS: Record<string, Analyzer> = {
  mysql: analyzeMysql,
  postgresql: analyzePostgresql,
  sqlite: analyzeSqlite
};

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();

  return items.filter(item => {
    const value = key(item);

    if (seen.has(value))
      return false;

    seen.add(value);
    return true;
  });
}

/** 根据执行计划结果与数据库类型生成分析结论与 SQL 建议 */
export function analyzePlan(
  plan: QueryResultPayload | null | undefined,
  sql: string,
  dbType?: string
): PlanAnalysis {
  if (!plan || (plan.rows?.length ?? 0) === 0)
    return EMPTY_ANALYSIS;

  const findings: PlanFinding[] = [];
  const suggestions: PlanSuggestion[] = [];
  const analyzer = ANALYZERS[(dbType ?? "").toLowerCase()] ?? analyzeGeneric;

  analyzer(plan, sql, findings, suggestions);

  const dedupedFindings = uniqueBy(findings, item => `${item.level}|${item.title}`);
  const dedupedSuggestions = uniqueBy(suggestions, item => `${item.title}|${item.sql ?? ""}`);
  const warnings = dedupedFindings.filter(item => item.level !== "info").length;

  let summary: string;

  if (warnings > 0)
    summary = `发现 ${warnings} 项潜在性能问题`;
  else if (dedupedFindings.length > 0)
    summary = `未发现明显性能风险，另有 ${dedupedFindings.length} 条提示`;
  else
    summary = "未发现明显的性能问题";

  return { summary, findings: dedupedFindings, suggestions: dedupedSuggestions };
}
