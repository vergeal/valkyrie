package valkyrie.driver.api.sql;

import lombok.Getter;
import lombok.Setter;
import valkyrie.driver.utils.SQLParser;

import java.util.LinkedHashSet;
import java.util.Set;

import static valkyrie.utils.string.StrStaticImports.lowercase;
import static valkyrie.utils.string.StrStaticImports.strhas;

/**
 * 一条已解析的 SQL 语句：原文 + 命令类型 + 涉及的（单）表名。
 * <p>
 * 命令类型与表名都由手写解析得到（按首关键字判类型、按 FROM 子句判单表），
 * 不再依赖第三方 SQL 解析器；解析不了就按纯文本执行。
 *
 * @author Luo Tiansheng
 * @since 2026/4/02
 */
@Getter
public class SQLParsedStatement
{
        /**
         * 命令类型
         */
        @Setter
        private SQLCommandType command;

        /**
         * sql 脚本原文
         */
        private final String textValue;

        /**
         * SQL 语句中的表名（只对简单单表查询给出，可能为空）
         */
        private final Set<String> tables = new LinkedHashSet<>();

        public SQLParsedStatement(String text, SQLCommandType command)
        {
                this.textValue = text;
                this.command = command != null ? command : classify(text);
                this.tables.addAll(SQLParser.tableNames(text));
        }

        public boolean isSingleTable()
        {
                return tables.size() == 1;
        }

        public String getSingleTableName()
        {
                return tables.size() == 1 ? tables.iterator().next() : null;
        }

        /**
         * 按首关键字粗判命令类型。
         * <ul>
         *     <li>能返回结果集的查询类语句（select/show/desc/pragma/with/values/table 等）→ {@code EXECUTE_QUERY}</li>
         *     <li>{@code SELECT ... INTO}（写入用户变量或文件，不返回结果集）→ {@code EXECUTE}</li>
         *     <li>DML（insert/update/delete/merge/...）与提交回滚 → {@code EXECUTE_UPDATE}，走 executeUpdate 拿影响行数</li>
         *     <li>其余（DDL/DCL/MySQL 特有管理语句等）→ {@code EXECUTE}，走 {@code Statement.execute()}</li>
         * </ul>
         */
        static SQLCommandType classify(String sql)
        {
                /* 先去掉注释：语句前面带块注释或行注释时，也按真正的首关键字判断 */
                String lower = lowercase(SQLParser.stripComments(sql)).trim();
                String word = firstWord(lower);

                if (word == null)
                        return SQLCommandType.EXECUTE;

                /* SELECT ... INTO 用户变量 / OUTFILE / DUMPFILE 不产生结果集 */
                if (word.equals("select") && strhas(lower, " into "))
                        return SQLCommandType.EXECUTE;

                if (isQueryLike(word))
                        return SQLCommandType.EXECUTE_QUERY;

                if (isUpdateLike(word))
                        return SQLCommandType.EXECUTE_UPDATE;

                return SQLCommandType.EXECUTE;
        }

        private static boolean isQueryLike(String word)
        {
                return word.equals("select")
                        || word.equals("show")
                        || word.equals("desc")
                        || word.equals("describe")
                        || word.equals("explain")
                        || word.equals("pragma")
                        || word.equals("with")
                        || word.equals("values")
                        || word.equals("table");
        }

        private static boolean isUpdateLike(String word)
        {
                return word.equals("insert")
                        || word.equals("update")
                        || word.equals("delete")
                        || word.equals("replace")
                        || word.equals("merge")
                        || word.equals("upsert")
                        || word.equals("commit")
                        || word.equals("rollback");
        }

        /** 首个连续字母组成的单词（小写），跳过前导的括号 / 空白等 */
        private static String firstWord(String lower)
        {
                int n = lower.length();
                int i = 0;

                while (i < n && !Character.isLetter(lower.charAt(i)))
                        i++;

                int j = i;

                while (j < n && Character.isLetter(lower.charAt(j)))
                        j++;

                return i < j ? lower.substring(i, j) : null;
        }

        @Override
        public String toString()
        {
                return textValue;
        }
}
