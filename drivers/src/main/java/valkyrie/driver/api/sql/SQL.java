package valkyrie.driver.api.sql;

import lombok.Getter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import valkyrie.utils.collection.Lists;

import java.util.Iterator;
import java.util.List;

import static valkyrie.utils.collection.Lists.last;
import static valkyrie.utils.string.StrStaticImports.fmt;

/**
 * SQL 执行单元
 * <p>
 * 表示一次用户提交的 SQL 内容，支持包含多条语句。
 * 每条语句可能属于不同类型（SELECT / DDL / DML / DCL / TCL / 扩展语句）。
 * <p>
 * 执行特性：
 * - SQL 内容可能包含多条语句（按分隔符拆分后执行）
 * - 执行顺序严格按照语句顺序
 * - 每条语句独立产生执行结果
 * <p>
 * 使用场景：
 * - 编辑器执行选中 SQL
 * - 脚本批量执行
 * - 控制台命令执行
 * <p>
 * 该接口由各自驱动独立实现，其中 SQL 方言解析等内容，由子类自由实现。
 *
 * @author Luo Tiansheng
 * @since 2026/4/11
 */
public class SQL implements Iterable<SQLParsedStatement>
{
        private static final Logger LOG = LoggerFactory.getLogger(SQL.class);

        @Getter
        private final String raw;

        private final List<SQLParsedStatement> statements = Lists.newArrayList();

        public SQL(Object sqlfmt, Object... args)
        {
                this(null, fmt(sqlfmt, args));

        }

        public SQL(SQLCommandType type, String raw)
        {
                this.raw = raw;

                parse(type, raw);
        }

        /**
         * 拆分解析 SQL：按分号把脚本切成独立语句，逐条按首关键字判命令类型。
         * <p>
         * 不再依赖第三方解析器；{@code SET @var := ...}、{@code SELECT ... INTO @var}、
         * {@code PREPARE}/{@code DEALLOCATE} 等方言语句都能按文本照常执行。
         */
        private void parse(SQLCommandType type, String raw)
        {
                for (String part : splitStatements(raw))
                        this.statements.add(new SQLParsedStatement(part, type));
        }

        /**
         * 按分号将原始 SQL 切分为独立语句文本。
         * <p>
         * 切分过程会跳过字符串/引用标识符（含引号转义）以及行注释（--、#）与块注释（/* ... *{@code /}），
         * 避免语句内部出现分号或注释时被误切分。
         */
        private static List<String> splitStatements(String raw)
        {
                List<String> ret = Lists.newArrayList();

                StringBuilder part = new StringBuilder();
                int i = 0;
                int n = raw.length();
                char quote = 0;

                while (i < n) {
                        char c = raw.charAt(i);

                        /*
                         * 注释：跳过时原样留下。注释里可能有分号不能当分隔符，
                         * 但执行要发原文（优化器提示注释、MySQL 版本注释都有效），
                         * 不能像以前那样丢掉 —— 那样会把提示注释吃掉，还可能把前后 token 粘一起。
                         */
                        if (quote == 0 && c == '-' && i + 1 < n && raw.charAt(i + 1) == '-') {
                                int end = skipToLineEnd(raw, i + 2);
                                part.append(raw, i, end);
                                i = end;
                                continue;
                        }

                        if (quote == 0 && c == '#') {
                                int end = skipToLineEnd(raw, i + 1);
                                part.append(raw, i, end);
                                i = end;
                                continue;
                        }

                        if (quote == 0 && c == '/' && i + 1 < n && raw.charAt(i + 1) == '*') {
                                int end = raw.indexOf("*/", i + 2);
                                end = end < 0 ? n : end + 2;
                                part.append(raw, i, end);
                                i = end;
                                continue;
                        }

                        /* 进入字符串 / 引用标识符 */
                        if (quote == 0 && isQuote(c)) {
                                quote = c;
                                part.append(c);
                                i++;
                                continue;
                        }

                        if (quote != 0) {
                                part.append(c);

                                /* 反斜杠转义 */
                                if (c == '\\' && i + 1 < n) {
                                        part.append(raw.charAt(i + 1));
                                        i += 2;
                                        continue;
                                }

                                /* 引号结束（连续双引号视为转义，字符串继续） */
                                if (c == quote) {
                                        if (i + 1 < n && raw.charAt(i + 1) == quote) {
                                                part.append(quote);
                                                i += 2;
                                                continue;
                                        }
                                        quote = 0;
                                }

                                i++;
                                continue;
                        }

                        /* 语句结束 */
                        if (c == ';') {
                                collect(part, ret);
                                i++;
                                continue;
                        }

                        part.append(c);
                        i++;
                }

                collect(part, ret);

                return ret;
        }

        private static boolean isQuote(char c)
        {
                return c == '\'' || c == '"' || c == '`';
        }

        private static int skipToLineEnd(String raw, int from)
        {
                int end = raw.indexOf('\n', from);
                return end < 0 ? raw.length() : end + 1;
        }

        private static void collect(StringBuilder part, List<String> ret)
        {
                String sql = part.toString().trim();
                part.setLength(0);

                if (!sql.isEmpty())
                        ret.add(sql);
        }

        public SQLParsedStatement getLast()
        {
                return last(statements);
        }

        @Override
        public Iterator<SQLParsedStatement> iterator()
        {
                return statements.iterator();
        }

        public String getSingleTableName()
        {
                return last(statements).getSingleTableName();
        }
}
