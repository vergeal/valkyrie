package valkyrie.driver.utils;

import valkyrie.driver.api.Column;
import valkyrie.driver.api.Dialect;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static valkyrie.utils.string.StrStaticImports.uppercase;

/**
 * SQL 文本工具：去注释、单表名提取、CREATE TABLE 列定义解析。
 * <p>
 * 全部手写（不依赖第三方 SQL 解析器）：只做本驱动层真正需要的少量事 ——
 * 判断语句是不是「简单单表查询」（决定结果网格能否内联编辑）、
 * 从建表语句里取权威列类型与默认值（表设计器用）。
 *
 * @author Luo Tiansheng
 * @since 2026/4/7
 */
public class SQLParser
{
        /* ********************************************************************* */
        /*                              去注释                                    */
        /* ********************************************************************* */

        /**
         * 去掉 SQL 里的注释（行注释 {@code --} / {@code #}、块注释 {@code /* ... *}{@code /}，可跨行），
         * 字符串与引用标识符里的注释符号保持原样。注释用一个空格替换，避免把前后 token 粘在一起。
         * <p>
         * 用于按关键字判断语句类型、抽取表名等场景：注释里出现 select / from 之类字样不应影响判断。
         */
        public static String stripComments(String sql)
        {
                if (sql == null || sql.isEmpty())
                        return sql == null ? null : "";

                StringBuilder out = new StringBuilder(sql.length());
                int i = 0;
                int n = sql.length();
                char quote = 0;

                while (i < n) {
                        char c = sql.charAt(i);

                        if (quote != 0) {
                                out.append(c);

                                if (c == '\\' && quote != '`' && i + 1 < n) {
                                        out.append(sql.charAt(i + 1));
                                        i += 2;
                                        continue;
                                }

                                if (c == quote) {
                                        /* 连续两个引号是转义，字符串继续 */
                                        if (i + 1 < n && sql.charAt(i + 1) == quote) {
                                                out.append(quote);
                                                i += 2;
                                                continue;
                                        }

                                        quote = 0;
                                }

                                i++;
                                continue;
                        }

                        if (c == '\'' || c == '"' || c == '`') {
                                quote = c;
                                out.append(c);
                                i++;
                                continue;
                        }

                        if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                                i = skipLine(sql, i + 2);
                                out.append(' ');
                                continue;
                        }

                        if (c == '#') {
                                i = skipLine(sql, i + 1);
                                out.append(' ');
                                continue;
                        }

                        if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                                int end = sql.indexOf("*/", i + 2);
                                i = end < 0 ? n : end + 2;
                                out.append(' ');
                                continue;
                        }

                        out.append(c);
                        i++;
                }

                return out.toString();
        }

        private static int skipLine(String sql, int from)
        {
                int end = sql.indexOf('\n', from);
                return end < 0 ? sql.length() : end + 1;
        }

        /**
         * 片段里是否有真正要执行的 SQL：用来区分「纯注释片段」与「可执行注释」。
         * 纯行注释（{@code --} / {@code #}）与普通块注释不算内容；
         * MySQL 版本注释 {@code /*! ... *}{@code /} 与 Oracle 优化器提示 {@code /*+ ... *}{@code /} 算内容。
         */
        public static boolean hasExecutableContent(String sql)
        {
                if (sql == null)
                        return false;

                int i = 0;
                int n = sql.length();

                while (i < n) {
                        char c = sql.charAt(i);

                        if (Character.isWhitespace(c)) {
                                i++;
                                continue;
                        }

                        if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                                i = skipLine(sql, i + 2);
                                continue;
                        }

                        if (c == '#') {
                                i = skipLine(sql, i + 1);
                                continue;
                        }

                        if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                                if (i + 2 < n && (sql.charAt(i + 2) == '!' || sql.charAt(i + 2) == '+'))
                                        return true;

                                int end = sql.indexOf("*/", i + 2);
                                i = end < 0 ? n : end + 2;
                                continue;
                        }

                        /* 出现任何其它字符（字母 / 数字 / 引号等）都算有内容 */
                        return true;
                }

                return false;
        }

        /* ********************************************************************* */
        /*                              词法分析                                  */
        /* ********************************************************************* */

        private enum Kind { WORD, QUOTED, STRING, PUNCT }

        /** 词法单元：text 为原文片段，depth 为所在括号层级（不含自身括号），start/end 为在原文中的下标 */
        private record Token(Kind kind, String text, int depth, int start, int end) { }

        private static boolean isPunct(char c)
        {
                return c == '(' || c == ')' || c == ',' || c == '.' || c == ';';
        }

        /** 把 SQL 切成词法单元：跳过空白与注释，识别字符串 / 引用标识符，记录括号层级 */
        private static List<Token> tokenize(String sql)
        {
                List<Token> tokens = new ArrayList<>();
                int i = 0;
                int n = sql.length();
                int depth = 0;

                while (i < n) {
                        char c = sql.charAt(i);

                        if (Character.isWhitespace(c)) {
                                i++;
                                continue;
                        }

                        /* 行注释 -- / #，块注释 */
                        if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                                i = skipLine(sql, i + 2);
                                continue;
                        }

                        if (c == '#') {
                                i = skipLine(sql, i + 1);
                                continue;
                        }

                        if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                                int end = sql.indexOf("*/", i + 2);
                                i = end < 0 ? n : end + 2;
                                continue;
                        }

                        /* 字符串字面量 */
                        if (c == '\'') {
                                int start = i;
                                i++;

                                while (i < n) {
                                        char d = sql.charAt(i);

                                        if (d == '\\' && i + 1 < n) {
                                                i += 2;
                                                continue;
                                        }

                                        if (d == '\'') {
                                                if (i + 1 < n && sql.charAt(i + 1) == '\'') {
                                                        i += 2;
                                                        continue;
                                                }

                                                i++;
                                                break;
                                        }

                                        i++;
                                }

                                int end = Math.min(i, n);
                                tokens.add(new Token(Kind.STRING, sql.substring(start, end), depth, start, end));
                                continue;
                        }

                        /* 引用标识符 "xxx" / `xxx` */
                        if (c == '"' || c == '`') {
                                int start = i;
                                i++;

                                while (i < n) {
                                        char d = sql.charAt(i);

                                        if (d == c) {
                                                if (i + 1 < n && sql.charAt(i + 1) == c) {
                                                        i += 2;
                                                        continue;
                                                }

                                                i++;
                                                break;
                                        }

                                        i++;
                                }

                                int end = Math.min(i, n);
                                tokens.add(new Token(Kind.QUOTED, sql.substring(start, end), depth, start, end));
                                continue;
                        }

                        if (c == '(') {
                                tokens.add(new Token(Kind.PUNCT, "(", depth, i, i + 1));
                                depth++;
                                i++;
                                continue;
                        }

                        if (c == ')') {
                                depth = Math.max(0, depth - 1);
                                tokens.add(new Token(Kind.PUNCT, ")", depth, i, i + 1));
                                i++;
                                continue;
                        }

                        if (c == ',' || c == '.' || c == ';') {
                                tokens.add(new Token(Kind.PUNCT, String.valueOf(c), depth, i, i + 1));
                                i++;
                                continue;
                        }

                        /* 标识符 / 关键字 / 数字 / 运算符：一直读到空白、标点或引号 */
                        int start = i;

                        while (i < n) {
                                char d = sql.charAt(i);

                                if (Character.isWhitespace(d) || isPunct(d) || d == '\'' || d == '"' || d == '`')
                                        break;

                                i++;
                        }

                        tokens.add(new Token(Kind.WORD, sql.substring(start, i), depth, start, i));
                }

                return tokens;
        }

        /**
         * 首个关键字（小写），不分配词法单元、跳过注释与字符串：
         * 用于「先廉价判一下语句类型，再决定要不要真正词法分析」。
         */
        public static String firstKeyword(String sql)
        {
                if (sql == null)
                        return null;

                int i = 0;
                int n = sql.length();

                while (i < n) {
                        char c = sql.charAt(i);

                        if (Character.isWhitespace(c)) {
                                i++;
                                continue;
                        }

                        if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-') {
                                i = skipLine(sql, i + 2);
                                continue;
                        }

                        if (c == '#') {
                                i = skipLine(sql, i + 1);
                                continue;
                        }

                        if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                                int end = sql.indexOf("*/", i + 2);
                                i = end < 0 ? n : end + 2;
                                continue;
                        }

                        if (c == '\'' || c == '"' || c == '`') {
                                i = skipQuoted(sql, i, c);
                                continue;
                        }

                        if (Character.isLetter(c)) {
                                int j = i;

                                while (j < n && Character.isLetter(sql.charAt(j)))
                                        j++;

                                return sql.substring(i, j).toLowerCase();
                        }

                        i++;
                }

                return null;
        }

        private static int skipQuoted(String sql, int from, char quote)
        {
                int i = from + 1;
                int n = sql.length();

                while (i < n) {
                        char c = sql.charAt(i);

                        if (c == '\\' && quote != '`' && i + 1 < n) {
                                i += 2;
                                continue;
                        }

                        if (c == quote) {
                                if (i + 1 < n && sql.charAt(i + 1) == quote) {
                                        i += 2;
                                        continue;
                                }

                                return i + 1;
                        }

                        i++;
                }

                return n;
        }

        /* ********************************************************************* */
        /*                          单表名提取                                    */
        /* ********************************************************************* */

        private static final Set<String> QUERY_LEADING = Set.of(
                "select", "show", "desc", "describe", "explain", "pragma", "with", "values", "table"
        );

        private static final Set<String> FROM_CLAUSE_END = Set.of(
                "where", "group", "order", "having", "limit", "union", "intersect", "except",
                "on", "using", "for", "offset", "fetch", "returning", "window", "qualify"
        );

        /**
         * 提取语句里的表名。只认「简单单表查询」：整条语句恰好一个顶层 FROM、
         * 没有 JOIN、FROM 列表只有一个表 —— 结果网格只有在这种查询上才做内联编辑。
         * <p>
         * 多表 / 子查询 / CTE 一律返回空集合（界面上退化为不可编辑），
         * 宁可少判，也不要把带 JOIN 的查询误判成单表去生成错误的 UPDATE / DELETE。
         */
        public static Set<String> tableNames(String sql)
        {
                Set<String> tables = new LinkedHashSet<>();

                if (sql == null || sql.isBlank())
                        return tables;

                /* 先廉价判首关键字：INSERT / DDL 这些根本不需要表名提取，别白词法分析一遍 */
                String first = firstKeyword(sql);

                if (first == null || !QUERY_LEADING.contains(first))
                        return tables;

                List<Token> tokens = tokenize(sql);

                int fromIndex = -1;
                int fromCount = 0;
                int joinCount = 0;

                for (int i = 0; i < tokens.size(); i++) {
                        Token token = tokens.get(i);

                        if (token.kind() != Kind.WORD)
                                continue;

                        String word = token.text().toLowerCase();

                        if (word.equals("from")) {
                                fromCount++;
                                if (fromIndex < 0)
                                        fromIndex = i;
                        } else if (word.equals("join")) {
                                joinCount++;
                        }
                }

                if (fromIndex < 0 || fromCount != 1 || joinCount != 0)
                        return tables;

                int depth = tokens.get(fromIndex).depth();
                int i = fromIndex + 1;

                if (i >= tokens.size())
                        return tables;

                Token nameToken = tokens.get(i);

                /* FROM 后面直接是 ( 子查询 / 变量，或不在同一层级：不认 */
                if (nameToken.depth() != depth || nameToken.kind() == Kind.PUNCT)
                        return tables;

                if (nameToken.kind() != Kind.WORD && nameToken.kind() != Kind.QUOTED)
                        return tables;

                StringBuilder name = new StringBuilder(nameToken.text());
                i++;

                /* 库.表 这种限定名拼回去 */
                while (i + 1 < tokens.size()
                        && tokens.get(i).kind() == Kind.PUNCT && tokens.get(i).text().equals(".")
                        && tokens.get(i).depth() == depth && tokens.get(i + 1).depth() == depth) {
                        name.append('.').append(tokens.get(i + 1).text());
                        i += 2;
                }

                /* FROM 列表里只要出现逗号就是多表 */
                for (int j = i; j < tokens.size(); j++) {
                        Token token = tokens.get(j);

                        if (token.depth() < depth)
                                break;

                        if (token.depth() > depth)
                                continue;

                        if (token.kind() == Kind.PUNCT && token.text().equals(","))
                                return tables;

                        if (token.kind() == Kind.WORD && FROM_CLAUSE_END.contains(token.text().toLowerCase()))
                                break;
                }

                tables.add(name.toString());

                return tables;
        }

        /* ********************************************************************* */
        /*                       CREATE TABLE 列定义解析                          */
        /* ********************************************************************* */

        private static final Set<String> TABLE_CONSTRAINTS = Set.of(
                "primary", "unique", "key", "index", "constraint", "foreign", "check", "fulltext", "spatial"
        );

        /* 类型词读到这些就停：它们是列约束 / 修饰，不属于类型本身 */
        private static final Set<String> TYPE_STOP = Set.of(
                "not", "null", "default", "primary", "unique", "auto_increment", "autoincrement",
                "comment", "collate", "references", "check", "constraint", "generated", "as",
                "identity", "unsigned", "zerofill", "on"
        );

        /* DEFAULT 值读到这些（后一个约束关键字）就停 */
        private static final Set<String> DEFAULT_STOP = Set.of(
                "not", "primary", "unique", "comment", "collate", "references", "check",
                "constraint", "generated", "auto_increment", "autoincrement", "identity", "on"
        );

        /**
         * 从 DDL 中解析字段权威类型和默认值，写回 {@code metas} 里同名的列。
         * <p>
         * 只做本表设计器需要的事：按顶层逗号切列定义，跳过表级约束，取列名后的类型词，
         * 以及 {@code DEFAULT} 后面的原样表达式。解析失败（没有括号 / 认不出来）就什么都不做，
         * 不像以前那样直接抛异常 —— 关键字做列名的建表语句也能正常读结构。
         */
        public static void parseColumnDefSpec(String ddl, Dialect dialect, Map<String, Column> metas)
        {
                if (ddl == null || ddl.isBlank() || metas == null || metas.isEmpty())
                        return;

                List<Token> tokens = tokenize(ddl);
                int open = -1;

                for (int i = 0; i < tokens.size(); i++) {
                        Token token = tokens.get(i);

                        if (token.kind() == Kind.PUNCT && token.text().equals("(") && token.depth() == 0) {
                                open = i;
                                break;
                        }
                }

                if (open < 0)
                        return;

                int close = tokens.size();

                for (int i = open + 1; i < tokens.size(); i++) {
                        Token token = tokens.get(i);

                        if (token.kind() == Kind.PUNCT && token.text().equals(")") && token.depth() == 0) {
                                close = i;
                                break;
                        }
                }

                /* 按顶层（括号内第 1 层）逗号切成一个个列定义 */
                List<List<Token>> definitions = new ArrayList<>();
                List<Token> current = null;

                for (int i = open + 1; i < close; i++) {
                        Token token = tokens.get(i);

                        if (token.kind() == Kind.PUNCT && token.text().equals(",") && token.depth() == 1) {
                                if (current != null)
                                        definitions.add(current);

                                current = null;
                                continue;
                        }

                        if (current == null)
                                current = new ArrayList<>();

                        current.add(token);
                }

                if (current != null)
                        definitions.add(current);

                for (List<Token> definition : definitions) {
                        if (definition.size() < 2)
                                continue;

                        Token nameToken = definition.getFirst();

                        if (nameToken.kind() != Kind.WORD && nameToken.kind() != Kind.QUOTED)
                                continue;

                        if (TABLE_CONSTRAINTS.contains(stripQuotes(nameToken.text()).toLowerCase()))
                                continue;

                        Column column = findColumn(metas, dialect, nameToken.text());

                        if (column == null)
                                continue;

                        String type = readType(definition);

                        if (type != null)
                                column.setType(type);

                        applyDefault(ddl, definition, column);
                }
        }

        private static Column findColumn(Map<String, Column> metas, Dialect dialect, String raw)
        {
                Column column = metas.get(raw);

                if (column != null)
                        return column;

                column = metas.get(stripQuotes(raw));

                if (column != null)
                        return column;

                String removed = dialect == null ? null : dialect.removeQuote(raw);

                return removed == null ? null : metas.get(removed);
        }

        /** 类型：列名之后、遇到括号或列约束关键字之前的所有词，拼起来大写 */
        private static String readType(List<Token> definition)
        {
                StringBuilder type = new StringBuilder();

                for (int i = 1; i < definition.size(); i++) {
                        Token token = definition.get(i);

                        if (token.kind() == Kind.PUNCT)
                                break;

                        if (token.kind() != Kind.WORD)
                                break;

                        if (TYPE_STOP.contains(token.text().toLowerCase()))
                                break;

                        if (!type.isEmpty())
                                type.append(' ');

                        type.append(token.text());
                }

                return type.isEmpty() ? null : uppercase(type.toString());
        }

        /** DEFAULT 后面的表达式：直接取原文片段，保留引号 / 函数调用；{@code NULL} 存 null */
        private static void applyDefault(String ddl, List<Token> definition, Column column)
        {
                for (int i = 1; i < definition.size(); i++) {
                        Token token = definition.get(i);

                        if (token.kind() != Kind.WORD || !token.text().equalsIgnoreCase("default"))
                                continue;

                        if (i + 1 >= definition.size())
                                return;

                        String value = getString(ddl, definition, i);

                        column.setDefaultValue(value.isEmpty() || value.equalsIgnoreCase("null") ? null : value);
                        return;
                }
        }

        private static String getString(String ddl, List<Token> definition, int i)
        {
                int valueStart = definition.get(i + 1).start();
                int valueEnd = definition.getLast().end();

                for (int j = i + 1; j < definition.size(); j++) {
                        Token next = definition.get(j);

                        if (next.depth() != 1 || next.kind() != Kind.WORD)
                                continue;

                        if (DEFAULT_STOP.contains(next.text().toLowerCase())) {
                                valueEnd = next.start();
                                break;
                        }
                }

                return ddl.substring(valueStart, Math.min(valueEnd, ddl.length())).trim();
        }

        private static String stripQuotes(String text)
        {
                if (text == null || text.length() < 2)
                        return text;

                char first = text.charAt(0);
                char last = text.charAt(text.length() - 1);

                if ((first == '"' && last == '"') || (first == '`' && last == '`')
                        || (first == '[' && last == ']'))
                        return text.substring(1, text.length() - 1);

                return text;
        }
}
