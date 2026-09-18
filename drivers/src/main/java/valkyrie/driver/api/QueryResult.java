package valkyrie.driver.api;

import lombok.Getter;
import lombok.Setter;
import net.sf.jsqlparser.expression.Expression;
import net.sf.jsqlparser.expression.LongValue;
import net.sf.jsqlparser.expression.NullValue;
import net.sf.jsqlparser.expression.StringValue;
import net.sf.jsqlparser.expression.operators.conditional.AndExpression;
import net.sf.jsqlparser.expression.operators.relational.EqualsTo;
import net.sf.jsqlparser.expression.operators.relational.IsNullExpression;
import net.sf.jsqlparser.schema.Table;
import net.sf.jsqlparser.statement.delete.Delete;
import net.sf.jsqlparser.statement.select.Limit;
import net.sf.jsqlparser.statement.update.Update;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.sql.SQL;
import valkyrie.utils.Optional;
import valkyrie.utils.collection.Lists;
import valkyrie.utils.collection.Maps;

import java.util.*;

/**
 * @author Luo Tiansheng
 * @since 2026/4/11
 */
@Getter
@Setter
public class QueryResult
{
        @Getter
        private List<Column> columns;

        private final Map<String, Integer> columnIndices = Maps.newHashMap();

        private List<Column> pks;

        @Setter
        @Getter
        private List<GridRow> rows = Lists.newArrayList();

        @Setter
        @Getter
        private boolean editable = false;

        @Setter
        @Getter
        private boolean addable = false;

        private final Session session;
        private final Driver driver;

        private final Map<Integer, GridRow> updateRowBuffer = new HashMap<>();

        /**
         * 待提交的删除行：删行只记账，点「提交修改」才真正发 DELETE，中途可以「回滚」。
         * （以前是直接执行 DELETE，删了就没有回头路。）
         */
        private final Set<Integer> deleteRowBuffer = new LinkedHashSet<>();

        /** addEmptyRow 追加的空行（还没入库）：删掉它们不必发 DELETE，重新读一遍即可 */
        private final Set<Integer> addedRowBuffer = new LinkedHashSet<>();

        private final SQL sql;

        public interface UpdateListener
        {
                void update(GridRow row);
        }

        @Setter
        private UpdateListener updateListener;

        /**
         * 构造器
         */
        public QueryResult(Session session, Driver driver, SQL sql)
        {
                this.session = session;
                this.driver = driver;
                this.sql = sql;
        }
        
        public static QueryResult ofValue(Session session, String value)
        {
                QueryResult queryResult = new QueryResult(session, null, null);
                
                Column col = new Column();
                col.setLabel("Value");
                col.setName("Value");
                col.setType("Object");

                queryResult.setColumns(Lists.of(col));
                queryResult.addEmptyRow();
                queryResult.getRows().getFirst().set(0, value);

                return queryResult;
        }

        public static QueryResult ofList(Session session, List<String> list)
        {
                QueryResult queryResult = new QueryResult(session, null, null);

                Column col = new Column();
                col.setLabel("Value");
                col.setName("Value");
                col.setType("ANY");

                queryResult.setColumns(Lists.of(col));

                list.forEach(e -> {
                        GridRow row = new GridRow();
                        row.add(e);
                        queryResult.rows.add(row);
                });

                return queryResult;
        }

        public int size()
        {
                return rows.size();
        }

        /**
         * 行的「当前展示值」：有未提交修改时取缓冲里的版本，否则取原始行。
         *
         * @param index 行下标
         * @return 对应行；下标越界时返回 {@code null}
         */
        public GridRow effectiveRow(int index)
        {
                if (index < 0 || index >= rows.size())
                        return null;

                return updateRowBuffer.getOrDefault(index, rows.get(index));
        }

        public void setColumns(List<Column> columns)
        {
                this.columns = columns;

                pks = columns.stream()
                        .filter(Column::isPrimary)
                        .toList();

                for (int i = 0; i < columns.size(); i++)
                        columnIndices.put(columns.get(i).getLabel(), i);
        }


        public void reload()
        {
                if (driver != null && session != null && sql != null) {

                        QueryResult queryResult = driver.execute(session, sql);

                        columns = queryResult.columns;
                        rows = queryResult.rows;

                        clearUpdateBuffer();

                }
        }

        public void addEmptyRow()
        {
                rows.addLast(new GridRow(columns.size()));
                addedRowBuffer.add(rows.size() - 1);
        }

        /**
         * 删除行：只记进待提交缓冲（与单元格编辑同一套语义），
         * 提交时才执行 DELETE，回滚时直接丢弃。
         */
        public void remove(List<Integer> indices)
        {
                if (indices == null || indices.isEmpty())
                        return;

                for (int index : indices) {
                        if (index < 0 || index >= rows.size())
                                continue;

                        /* 这行都要删了，之前对它做的单元格改动一并作废 */
                        updateRowBuffer.remove(index);
                        addedRowBuffer.remove(index);
                        deleteRowBuffer.add(index);
                }
        }

        public void addUpdateRow(int colIndex, int rowIndex, String newValue)
        {
                if (rowIndex < 0)
                        return;

                GridRow row = new GridRow();

                if (updateRowBuffer.containsKey(rowIndex)) {
                        row.addAll(updateRowBuffer.get(rowIndex));
                } else {
                        row.addAll(rows.get(rowIndex));
                }

                row.set(colIndex, newValue);

                updateRowBuffer.put(rowIndex, row);

                if (updateListener != null)
                        updateListener.update(row);

        }

        /**
         * 在指定行里做不区分大小写的全局替换，结果记入待提交缓冲（与单元格编辑同一套语义），
         * 必须点「提交修改」才会写库，中途可以「回滚」。
         *
         * @param rowIndices 参与替换的行下标（搜索过滤时传可见行，避免改到看不见的数据）
         * @param find       被替换的文本
         * @param replacement 替换成的文本
         * @return 实际改动的单元格数
         */
        public int replaceValues(int[] rowIndices, String find, String replacement)
        {
                if (columns == null || rowIndices == null || find == null || find.isEmpty())
                        return 0;

                String target = replacement == null ? "" : replacement;
                int changed = 0;

                for (int rowIndex : rowIndices) {
                        if (rowIndex < 0 || rowIndex >= rows.size())
                                continue;

                        /* 以缓冲里的最新值为准：替换前手动改过的单元格也要能被替换到 */
                        GridRow effective = updateRowBuffer.getOrDefault(rowIndex, rows.get(rowIndex));

                        for (int col = 0; col < columns.size() && col < effective.size(); col++) {
                                String current = effective.get(col);

                                if (current == null)
                                        continue;

                                String next = replaceAllIgnoreCase(current, find, target);

                                if (!next.equals(current)) {
                                        addUpdateRow(col, rowIndex, next);
                                        changed++;
                                }
                        }
                }

                return changed;
        }

        /**
         * 不区分大小写地把 {@code find} 全部替换成 {@code replacement}。
         * 用 regionMatches 逐位比对而不是先 toLowerCase，避免某些语言下
         * 大小写转换改变长度导致下标错位。
         */
        private static String replaceAllIgnoreCase(String text, String find, String replacement)
        {
                int length = find.length();
                StringBuilder builder = new StringBuilder();
                int from = 0;
                int index = 0;

                while (index <= text.length() - length) {
                        if (text.regionMatches(true, index, find, 0, length)) {
                                builder.append(text, from, index).append(replacement);
                                index += length;
                                from = index;
                        } else {
                                index++;
                        }
                }

                builder.append(text, from, text.length());
                return builder.toString();
        }

        public boolean isUpdatable()
        {
                return !updateRowBuffer.isEmpty();
        }

        /** 有未提交改动：改过单元格，或者标记了待删除的行 */
        public boolean isDirty()
        {
                return isUpdatable() || !deleteRowBuffer.isEmpty();
        }

        public void clearUpdateBuffer()
        {
                updateRowBuffer.clear();
                deleteRowBuffer.clear();
        }

        /**
         * 提交未保存的改动：先执行单元格更新，再执行待删除的行，最后重新读一遍结果。
         */
        public void update()
        {
                if (!isDirty())
                        return;

                if (isUpdatable())
                        executeChange(toUpdateSQL(), "没有匹配到需要更新的数据行，修改可能未生效");

                if (!deleteRowBuffer.isEmpty())
                        executeChange(toDeleteSQL(new ArrayList<>(deleteRowBuffer)), "没有匹配到需要删除的数据行，删除可能未生效");

                reload();
                updateRowBuffer.clear();
                deleteRowBuffer.clear();
        }

        /**
         * 执行一条改动语句并核对影响行数。
         * <p>
         * 影响行数为 0 说明 WHERE 没有匹配到原始数据行（数据可能已被其它会话修改，
         * 或无主键表的定位条件不精确）。此时必须报错，而不是静默重载旧数据，
         * 否则用户会看到"提交了但数据没变"。
         */
        private void executeChange(SQL statement, String emptyMessage)
        {
                int[] affected = { 0 };

                driver.execute(-1, session, statement, new SQLExecuteCallback()
                {
                        @Override
                        public void row(int value)
                        {
                                affected[0] += value;
                        }
                });

                if (affected[0] <= 0)
                        throw new DriverException(emptyMessage);
        }

        private SQL toDeleteSQL(List<Integer> indices)
        {
                List<Delete> deletes = new ArrayList<>();

                indices.forEach(index -> {
                        var delete = new Delete();
                        List<Expression> equals = new ArrayList<>();

                        var table = new Table(driver.getDialect().removeQuote(sql.getSingleTableName()));
                        delete.setTable(table);

                        List<Column> whereColumns = columns;

                        if (!pks.isEmpty())
                                whereColumns = pks;

                        whereColumns.forEach(col -> {

                                var w = equalsOrNull(col.getName(), rows.get(index).get(col.getIndex()));

                                equals.add(w);

                        });

                        Expression exp = equals.getFirst();

                        for (int i = 1; i < equals.size(); i++)
                                exp = new AndExpression(exp, equals.get(i));

                        delete.setWhere(exp);

                        if (pks.isEmpty()) {
                                Limit limit = new Limit();
                                limit.setRowCount(new LongValue(1));
                                delete.setLimit(limit);
                        }

                        deletes.add(delete);
                });

                StringBuilder builder = new StringBuilder();

                for (Delete delete : deletes)
                        builder.append(delete.toString()).append(";");

                return new SQL(builder.toString());
        }

        private SQL toUpdateSQL()
        {
                List<Update> updates = new ArrayList<>();

                for (Map.Entry<Integer, GridRow> entry : updateRowBuffer.entrySet()) {

                        var update = new Update();
                        var row = entry.getValue();

                        var table = new Table(driver.getDialect().removeQuote(sql.getSingleTableName()));
                        update.setTable(table);

                        for (int i = 0; i < row.size(); i++) {

                                String v = row.get(i);

                                if (!Objects.equals(v, rows.get(entry.getKey()).get(i))) {

                                        var c = new net.sf.jsqlparser.schema.Column(columns.get(i).getName());

                                        Expression exp;

                                        if (v != null) {
                                                exp = new StringValue(escape(v));
                                        } else {
                                                exp = new NullValue();
                                        }

                                        update.addUpdateSet(c, exp);

                                }

                        }

                        List<Column> whereColumns = columns;

                        if (!pks.isEmpty())
                                whereColumns = pks;

                        Expression whereExpression = null;

                        for (Column col : whereColumns) {

                                var r = rows.get(entry.getKey());
                                var w = equalsOrNull(col.getName(), r.get(col.getIndex()));

                                // 组合 WHERE 条件
                                if (whereExpression == null) {
                                        whereExpression = w;
                                } else {
                                        whereExpression = new AndExpression(whereExpression, w);
                                }

                        }

                        if (whereExpression != null)
                                update.setWhere(whereExpression);

                        /* 如果没有主键只修改一条 */
                        if (pks.isEmpty()) {
                                Limit limit = new Limit();
                                limit.setRowCount(new LongValue(1));
                                update.setLimit(limit);
                        }

                        updates.add(update);
                }

                StringBuilder builder = new StringBuilder();

                for (Update update : updates)
                        builder.append(update.toString()).append(";");

                return new SQL(builder.toString());
        }

        /**
         * 构造 {@code column = value} 定位条件；原值为 NULL 时使用
         * {@code column IS NULL}，避免生成恒不匹配的 {@code column = NULL}。
         */
        private static Expression equalsOrNull(String columnName, String value)
        {
                var column = new net.sf.jsqlparser.schema.Column(columnName);

                if (value == null)
                        return new IsNullExpression(column);

                var equals = new EqualsTo();
                equals.setLeftExpression(column);
                equals.setRightExpression(new StringValue(escape(value)));

                return equals;
        }

        /**
         * 转义字符串字面量中的单引号，防止生成的 SQL 语法错误。
         */
        private static String escape(String value)
        {
                return value.replace("'", "''");
        }

        /**
         * 根据列名获取指定行数据
         *
         * @param index 行索引
         * @param columnName 字段名
         * @return 对应行列值
         */
        public String getRowValue(int index, String columnName)
        {
                return getRowValue(index, columnIndices.get(columnName));
        }

        /**
         * 根据列名获取指定行数据
         *
         * @param index 行索引
         * @param col 列索引
         * @return 对应行列值
         */
        public String getRowValue(int index, int col)
        {
                return Optional.ifError(() -> rows.get(index).get(col), null);
        }
}
