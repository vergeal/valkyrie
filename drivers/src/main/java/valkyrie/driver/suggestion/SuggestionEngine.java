package valkyrie.driver.suggestion;

import valkyrie.driver.dm.DMSuggestions;
import valkyrie.driver.mysql.MySQLSuggestions;
import valkyrie.driver.postgresql.PostgresqlSuggestions;
import valkyrie.driver.redis.RedisSuggestions;
import valkyrie.driver.sqlite.SQLiteSuggestions;
import valkyrie.driver.api.Column;
import valkyrie.driver.api.Driver;
import valkyrie.driver.api.Session;
import valkyrie.driver.utils.SQLParser;

import java.util.Collection;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SQL 智能提示上下文引擎。
 * <p>
 * 在给定的 SQL 文本和光标位置下，解析出当前语句引用的表与别名，据此返回对应的
 * 提示项：
 * <ul>
 *   <li>{@code SELECT * FROM table_a WHERE |}：显示 table_a 的字段 + 关键字 + 表名</li>
 *   <li>{@code FROM table_a t0 JOIN table_b t1 ON t0.|}：只显示 table_a 的字段</li>
 * </ul>
 * 引擎构建（读取库表与字段元数据）需在后台线程完成，{@link #resolve} 为纯内存计算，
 * 可安全地在 JavaFX 线程中响应补全请求。
 *
 * @author Luo Tiansheng
 * @since 2026/9/11
 */
public class SuggestionEngine
{
        private static final Pattern TABLE_REF = Pattern.compile(
                "(?i)\\b(?:from|join)\\s+([`\"\\[]?[\\w.]+[`\"\\]]?)"
                        + "(?:\\s+(?:as\\s+)?([`\"\\[]?[\\w]+[`\"\\]]?))?");

        private static final Pattern QUALIFIER = Pattern.compile(
                "([`\"\\[]?[\\w]+[`\"\\]]?)\\s*\\.\\s*[\\w`\"\\[\\]]*$");

        /* 派生表：FROM ( ... ) 别名 / JOIN ( ... ) 别名 */
        private static final Pattern DERIVED_REF = Pattern.compile(
                "(?i)\\b(?:from|join)\\s*\\(");

        /* 子查询输出列里的显式别名：expr AS alias */
        private static final Pattern AS_ALIAS = Pattern.compile(
                "(?is)^(.*?)\\s+as\\s+([`\"\\[]?[\\w]+[`\"\\]]?)\\s*$");

        /* 子查询输出列是纯列引用（可带限定名）：t.col / col */
        private static final Pattern PLAIN_COLUMN = Pattern.compile(
                "^[`\"\\[]?[\\w$]+[`\"\\]]?(?:\\s*\\.\\s*[`\"\\[]?[\\w$]+[`\"\\]]?)*$");

        private static final Set<String> EXTRA_RESERVED = Set.of(
                "WHERE", "ON", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "INNER",
                "LEFT", "RIGHT", "FULL", "CROSS", "JOIN", "AS", "USING", "SET", "VALUES",
                "UNION", "SELECT", "AND", "OR", "BY", "INTO", "UPDATE", "DELETE");

        private final List<Suggestion> keywords;
        private final List<Suggestion> tables;
        private final Map<String, List<Suggestion>> columnsByTable;
        private final Set<String> reserved;

        private SuggestionEngine(List<Suggestion> keywords,
                                 List<Suggestion> tables,
                                 Map<String, List<Suggestion>> columnsByTable,
                                 Set<String> reserved)
        {
                this.keywords = keywords;
                this.tables = tables;
                this.columnsByTable = columnsByTable;
                this.reserved = reserved;
        }

        /**
         * 构建引擎（会访问数据库元数据，请在后台线程调用）
         */
        public static SuggestionEngine of(Driver driver, Session session)
        {
                List<Suggestion> keywords = new ArrayList<>();
                List<Suggestion> tables = new ArrayList<>();

                for (Suggestion suggestion : driver.getSuggestions(session)) {
                        switch (suggestion.getKind()) {
                                case "Class" -> tables.add(suggestion);
                                case "Field" -> { /* 扁平字段忽略，改用按表字段 */ }
                                default -> keywords.add(suggestion);
                        }
                }

                Map<String, List<Suggestion>> columnsByTable = new HashMap<>();

                try {
                        driver.getTableColumns(session).forEach((table, columns) -> {
                                List<Suggestion> fields = new ArrayList<>();

                                for (Column column : columns)
                                        fields.add(Suggestion.ofField(
                                                column.getName(), columnDetail(column)));

                                columnsByTable.put(table.toLowerCase(), fields);
                        });
                } catch (Exception e) {
                        /* 元数据读取失败时退化为仅关键字/表名提示 */
                }

                Set<String> reserved = new HashSet<>(EXTRA_RESERVED);
                keywords.forEach(s -> reserved.add(s.getLabel().toUpperCase()));

                return new SuggestionEngine(keywords, tables, columnsByTable, reserved);
        }

        /**
         * 只带关键字与函数的引擎：没有会话时用（连接已关闭 / 会话失效）。
         * <p>
         * 表名与字段来自数据库元数据，必须有活动会话才能取到，这里只按数据库类型
         * 给出该方言的关键字、函数与类型名，保证断开连接后编辑器依然有基础提示。
         *
         * @param type 数据库类型（mysql / postgresql / sqlite / dm / redis），未知类型退化为 SQL 标准关键字
         */
        public static SuggestionEngine keywords(String type)
        {
                Collection<Suggestion> values = switch (type == null ? "" : type.toLowerCase()) {
                        case "mysql" -> MySQLSuggestions.VALUES;
                        case "postgresql" -> PostgresqlSuggestions.VALUES;
                        case "sqlite" -> SQLiteSuggestions.VALUES;
                        case "dm" -> DMSuggestions.VALUES;
                        case "redis" -> RedisSuggestions.VALUES;
                        default -> SqlStandardSuggestions.VALUES;
                };

                List<Suggestion> keywords = new ArrayList<>(values);
                Set<String> reserved = new HashSet<>(EXTRA_RESERVED);

                keywords.forEach(suggestion -> reserved.add(suggestion.getLabel().toUpperCase()));

                return new SuggestionEngine(keywords, Collections.emptyList(), Collections.emptyMap(), reserved);
        }

        /**
         * 判断给定名称是否为当前会话下的表（用于编辑器表名跳转）
         */
        public boolean hasTable(String name)
        {
                return tableComment(name) != null;
        }

        /**
         * 返回表注释；{@code null} 表示不是当前会话下的表，空串表示表存在但无注释。
         * 供编辑器 Shortcut 悬停时展示。
         */
        public String tableComment(String name)
        {
                if (name == null || name.isBlank())
                        return null;

                String target = unquote(name.trim());

                for (Suggestion table : tables) {
                        if (table.getLabel().equalsIgnoreCase(target))
                                return table.getDetail() == null ? "" : table.getDetail();
                }

                return null;
        }

        private static String columnDetail(Column column)
        {
                if (column.getComment() != null && !column.getComment().isBlank())
                        return column.getComment();

                return column.getType() == null ? "" : column.getType();
        }

        /**
         * 根据光标上下文返回提示项（纯内存计算，可在 FX 线程执行）
         *
         * @param sql    编辑器完整文本
         * @param offset 光标在文本中的偏移
         */
        public List<Suggestion> resolve(String sql, int offset)
        {
                if (sql == null || sql.isEmpty())
                        return new ArrayList<>(keywords);

                offset = Math.max(0, Math.min(offset, sql.length()));

                /* 注释不参与上下文判断：注释里写 from xxx 不该被当成真实表引用 */
                String before = SQLParser.stripComments(sql.substring(0, offset));

                int statementStart = before.lastIndexOf(';') + 1;
                int statementEnd = sql.indexOf(';', offset);
                if (statementEnd < 0)
                        statementEnd = sql.length();

                String statement = SQLParser.stripComments(sql.substring(statementStart, statementEnd));

                Map<String, String> aliasToTable = new LinkedHashMap<>();
                List<String> referencedTables = new ArrayList<>();
                extractTables(statement, aliasToTable, referencedTables);

                /* 派生表（子查询）的别名 → 它的输出列，例如 ( SELECT ... ) u0 */
                Map<String, List<Suggestion>> derivedColumns = new LinkedHashMap<>();
                extractDerivedColumns(statement, derivedColumns);

                /* CTE：WITH name AS ( ... ) → name 的输出列，例如 T. / U. */
                extractCteColumns(statement, derivedColumns);

                /* 形如 t0. / table. 的限定名：只返回对应表的字段 */
                Matcher qualifier = QUALIFIER.matcher(before);
                if (qualifier.find()) {
                        String name = unquote(qualifier.group(1)).toLowerCase();
                        List<Suggestion> columns = derivedColumns.get(name);

                        if (columns == null) {
                                String table = aliasToTable.getOrDefault(name, name);
                                columns = columnsByTable.get(unquote(table).toLowerCase());
                        }

                        return columns == null ? new ArrayList<>() : columns;
                }

                List<Suggestion> result = new ArrayList<>();
                Set<String> added = new HashSet<>();

                for (String table : referencedTables) {
                        List<Suggestion> columns = columnsByTable.get(table.toLowerCase());

                        if (columns == null)
                                continue;

                        for (Suggestion column : columns) {
                                if (added.add(column.getLabel()))
                                        result.add(column);
                        }
                }

                /* 派生表的输出列也并进不带限定名的候选里 */
                for (List<Suggestion> columns : derivedColumns.values()) {
                        for (Suggestion column : columns) {
                                if (added.add(column.getLabel()))
                                        result.add(column);
                        }
                }

                result.addAll(keywords);
                result.addAll(tables);

                return result;
        }

        private void extractTables(String statement,
                                   Map<String, String> aliasToTable,
                                   List<String> referencedTables)
        {
                Matcher matcher = TABLE_REF.matcher(statement);

                while (matcher.find()) {
                        String table = unquote(matcher.group(1));
                        String key = table.contains(".")
                                ? table.substring(table.lastIndexOf('.') + 1)
                                : table;

                        if (!referencedTables.contains(key))
                                referencedTables.add(key);

                        aliasToTable.putIfAbsent(key.toLowerCase(), key);

                        String alias = matcher.group(2) == null ? null : unquote(matcher.group(2));

                        if (alias != null && !isReserved(alias))
                                aliasToTable.put(alias.toLowerCase(), key);
                }
        }

        private boolean isReserved(String value)
        {
                return reserved.contains(value.toUpperCase());
        }

        /**
         * 解析语句里的派生表：{@code FROM ( 子查询 ) 别名}，把子查询的输出列注册到别名上。
         * <p>
         * 只处理 FROM / JOIN 后面紧跟括号、且括号后有别名的情况；标量子查询
         * （如 {@code x = (SELECT ...)}）不做处理。
         */
        private void extractDerivedColumns(String statement, Map<String, List<Suggestion>> derived)
        {
                Matcher matcher = DERIVED_REF.matcher(statement);
                int from = 0;

                while (matcher.find(from)) {
                        int open = statement.indexOf('(', matcher.start());
                        int close = matchingParen(statement, open);

                        if (close < 0)
                                break;

                        String alias = aliasAfter(statement, close + 1);

                        if (alias != null && !alias.isBlank()) {
                                List<Suggestion> columns = selectListColumns(statement.substring(open + 1, close));

                                if (!columns.isEmpty())
                                        derived.put(alias.toLowerCase(), columns);
                        }

                        from = close + 1;
                }
        }

        /** 标识符与其结束下标 */
        private record Ident(String value, int end) {}

        /**
         * 解析 CTE：{@code WITH [RECURSIVE] name [(cols)] AS ( 子查询 ), ... }，
         * 把每个 CTE 的输出列注册到它的名字上（例如 T. / U.）。
         */
        private void extractCteColumns(String statement, Map<String, List<Suggestion>> derived)
        {
                int withAt = indexOfKeyword(statement, "with", 0);

                /* 只处理以 WITH 开头的整条语句 */
                if (withAt < 0 || !statement.substring(0, withAt).trim().isEmpty())
                        return;

                int i = skipWhitespace(statement, withAt + 4);

                if (keywordAt(statement, i, "recursive"))
                        i = skipWhitespace(statement, i + "recursive".length());

                while (i < statement.length()) {
                        i = skipWhitespace(statement, i);
                        Ident name = readIdentifier(statement, i);

                        if (name == null)
                                return;

                        i = skipWhitespace(statement, name.end());
                        List<String> explicit = null;

                        if (i < statement.length() && statement.charAt(i) == '(') {
                                int close = matchingParen(statement, i);

                                if (close < 0)
                                        return;

                                explicit = splitTopLevel(statement.substring(i + 1, close));
                                i = skipWhitespace(statement, close + 1);
                        }

                        if (!keywordAt(statement, i, "as"))
                                return;

                        i = skipWhitespace(statement, i + 2);

                        if (i >= statement.length() || statement.charAt(i) != '(')
                                return;

                        int close = matchingParen(statement, i);

                        if (close < 0)
                                return;

                        List<Suggestion> columns = new ArrayList<>();

                        if (explicit != null) {
                                for (String column : explicit) {
                                        String trimmed = column.trim();

                                        if (!trimmed.isEmpty())
                                                columns.add(Suggestion.ofField(unquote(trimmed), ""));
                                }
                        } else {
                                columns = selectListColumns(statement.substring(i + 1, close));
                        }

                        if (!columns.isEmpty())
                                derived.put(name.value().toLowerCase(), columns);

                        i = skipWhitespace(statement, close + 1);

                        if (i < statement.length() && statement.charAt(i) == ',') {
                                i++;
                                continue;
                        }

                        return;
                }
        }

        /** 从 start 读一个标识符（支持引号）；读不到返回 null */
        private static Ident readIdentifier(String text, int start)
        {
                if (start >= text.length())
                        return null;

                char c = text.charAt(start);

                if (isQuote(c)) {
                        int end = skipQuoted(text, start);
                        int stop = Math.min(end + 1, text.length());
                        return new Ident(unquote(text.substring(start, stop)), stop);
                }

                int i = start;

                while (i < text.length() && isIdentChar(text.charAt(i)))
                        i++;

                if (i == start)
                        return null;

                return new Ident(text.substring(start, i), i);
        }

        private static int skipWhitespace(String text, int from)
        {
                int i = Math.max(0, from);

                while (i < text.length() && Character.isWhitespace(text.charAt(i)))
                        i++;

                return i;
        }

        /** 判断 index 处是否为完整的关键字（前后是词边界，大小写不敏感） */
        private static boolean keywordAt(String text, int index, String keyword)
        {
                if (index < 0 || index + keyword.length() > text.length())
                        return false;

                if (!text.regionMatches(true, index, keyword, 0, keyword.length()))
                        return false;

                return (index == 0 || !isIdentChar(text.charAt(index - 1)))
                        && (index + keyword.length() >= text.length() || !isIdentChar(text.charAt(index + keyword.length())));
        }

        /** 返回与 text[open] 配对的右括号下标；找不到返回 -1 */
        private static int matchingParen(String text, int open)
        {
                if (open < 0 || open >= text.length() || text.charAt(open) != '(')
                        return -1;

                int depth = 0;

                for (int i = open; i < text.length(); i++) {
                        char c = text.charAt(i);

                        if (isQuote(c)) {
                                i = skipQuoted(text, i);
                                continue;
                        }

                        if (c == '(') {
                                depth++;
                        } else if (c == ')') {
                                depth--;

                                if (depth == 0)
                                        return i;
                        }
                }

                return -1;
        }

        /** 读取右括号后的别名（支持可选 AS 与引号标识符）；不是别名时返回 null */
        private String aliasAfter(String text, int start)
        {
                int i = start;

                while (i < text.length() && Character.isWhitespace(text.charAt(i)))
                        i++;

                if (i >= text.length())
                        return null;

                if (text.regionMatches(true, i, "as", 0, 2)
                        && (i + 2 >= text.length() || !isIdentChar(text.charAt(i + 2)))) {
                        i += 2;

                        while (i < text.length() && Character.isWhitespace(text.charAt(i)))
                                i++;
                }

                if (i >= text.length())
                        return null;

                char c = text.charAt(i);

                if (isQuote(c)) {
                        int end = skipQuoted(text, i);
                        String raw = text.substring(i, Math.min(end + 1, text.length()));
                        return unquote(raw);
                }

                int begin = i;

                while (i < text.length() && isIdentChar(text.charAt(i)))
                        i++;

                if (i == begin)
                        return null;

                String word = text.substring(begin, i);

                return isReserved(word) ? null : word;
        }

        /** 从子查询文本里取出顶层 SELECT 的输出列名 */
        private List<Suggestion> selectListColumns(String subquery)
        {
                int selectAt = indexOfKeyword(subquery, "select", 0);

                if (selectAt < 0)
                        return Collections.emptyList();

                int fromAt = indexOfKeyword(subquery, "from", selectAt + 6);
                String list = fromAt < 0 ? subquery.substring(selectAt + 6) : subquery.substring(selectAt + 6, fromAt);
                list = list.replaceFirst("(?is)^\\s*(distinct|all)\\b", "");

                List<Suggestion> columns = new ArrayList<>();

                for (String item : splitTopLevel(list)) {
                        String name = outputName(item.trim());

                        if (name != null && !name.isBlank() && !isReserved(name))
                                columns.add(Suggestion.ofField(unquote(name), ""));
                }

                return columns;
        }

        /** 从单个选择项推断输出列名：显式 AS 别名优先，其次纯列引用取末段 */
        private String outputName(String item)
        {
                Matcher as = AS_ALIAS.matcher(item);

                if (as.matches())
                        return as.group(2);

                if (PLAIN_COLUMN.matcher(item).matches()) {
                        int dot = item.lastIndexOf('.');
                        return dot >= 0 ? item.substring(dot + 1) : item;
                }

                return null;
        }

        /** 在顶层（括号外、字符串外）查找关键字，返回下标；找不到返回 -1 */
        private static int indexOfKeyword(String text, String keyword, int from)
        {
                int depth = 0;

                for (int i = Math.max(0, from); i < text.length(); i++) {
                        char c = text.charAt(i);

                        if (isQuote(c)) {
                                i = skipQuoted(text, i);
                                continue;
                        }

                        if (c == '(') {
                                depth++;
                                continue;
                        }

                        if (c == ')') {
                                depth = Math.max(0, depth - 1);
                                continue;
                        }

                        if (depth == 0
                                && (i == 0 || !isIdentChar(text.charAt(i - 1)))
                                && text.regionMatches(true, i, keyword, 0, keyword.length())
                                && (i + keyword.length() >= text.length() || !isIdentChar(text.charAt(i + keyword.length()))))
                                return i;
                }

                return -1;
        }

        /** 按顶层逗号切分（括号 / 字符串内的逗号不算） */
        private static List<String> splitTopLevel(String text)
        {
                List<String> parts = new ArrayList<>();
                int depth = 0;
                int start = 0;

                for (int i = 0; i < text.length(); i++) {
                        char c = text.charAt(i);

                        if (isQuote(c)) {
                                i = skipQuoted(text, i);
                                continue;
                        }

                        if (c == '(') {
                                depth++;
                        } else if (c == ')') {
                                depth = Math.max(0, depth - 1);
                        } else if (c == ',' && depth == 0) {
                                parts.add(text.substring(start, i));
                                start = i + 1;
                        }
                }

                parts.add(text.substring(start));

                return parts;
        }

        private static boolean isQuote(char c)
        {
                return c == '\'' || c == '"' || c == '`';
        }

        /** 跳过从 quote 开始的引号串（'' 转义），返回结束引号下标；未闭合返回末尾 */
        private static int skipQuoted(String text, int quoteAt)
        {
                char quote = text.charAt(quoteAt);

                for (int i = quoteAt + 1; i < text.length(); i++) {
                        if (text.charAt(i) == quote) {
                                if (i + 1 < text.length() && text.charAt(i + 1) == quote) {
                                        i++;
                                        continue;
                                }

                                return i;
                        }
                }

                return text.length() - 1;
        }

        private static boolean isIdentChar(char c)
        {
                return Character.isLetterOrDigit(c) || c == '_' || c == '$';
        }

        private static String unquote(String value)
        {
                if (value == null || value.length() < 2)
                        return value;

                char first = value.charAt(0);
                char last = value.charAt(value.length() - 1);

                if ((first == '`' && last == '`')
                        || (first == '"' && last == '"')
                        || (first == '[' && last == ']'))
                        return value.substring(1, value.length() - 1);

                return value;
        }
}
