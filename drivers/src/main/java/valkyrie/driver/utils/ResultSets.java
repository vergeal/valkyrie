package valkyrie.driver.utils;

import valkyrie.driver.api.Column;
import valkyrie.driver.api.Dialect;
import valkyrie.driver.api.GridRow;
import valkyrie.driver.api.QueryResult;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.sql.SQLParsedStatement;
import valkyrie.utils.collection.Lists;

import java.io.BufferedReader;
import java.sql.*;
import java.text.SimpleDateFormat;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 结果集工具
 *
 * @author Luo Tiansheng
 * @since 2026/3/30
 */
@SuppressWarnings("ALL")
public class ResultSets
{
        private static final String TIME_FORMAT_PATTERN = "yyyy-MM-dd HH:mm:ss";

        private static final DateTimeFormatter formatter = DateTimeFormatter.ofPattern(TIME_FORMAT_PATTERN);

        /*
         * 表的主键 / 列元数据：单表查询（含翻页）每次都要查数据库元数据，
         * 但它跟「本页选了哪些列」无关，短期内也不会变，按 表 缓存一小段时间。
         * 有 TTL，DDL 后最多 60 秒自动失效，不会长期用旧结构。
         */
        private static final long TABLE_META_TTL_MS = 60_000;
        private static final int TABLE_META_CACHE_LIMIT = 256;
        private static final Map<String, CachedTableMeta> TABLE_META_CACHE = new ConcurrentHashMap<>();

        private record CachedTableMeta(Set<String> primaryKeys, Map<String, Map<String, Object>> columns, long at) {
        }

        /* 8 位二进制字符串查表，替代逐字节 String.format（BLOB 转文本时快很多） */
        private static final String[] BINARY_BYTES = new String[256];

        static {
                for (int i = 0; i < 256; i++) {
                        String bits = Integer.toBinaryString(i);
                        BINARY_BYTES[i] = "0".repeat(8 - bits.length()) + bits;
                }
        }

        /**
         * 结果集转 QueryResultSet 对象
         */
        public static QueryResult toDataGrid(Connection connection,
                                             SQLParsedStatement ps,
                                             ResultSet rs,
                                             Dialect dialect,
                                             QueryResult queryResult)
                throws SQLException
        {
                SimpleDateFormat sdf = new SimpleDateFormat(TIME_FORMAT_PATTERN);

                /* COL */
                setColumns(connection, ps, rs, dialect, queryResult);

                /* ROW */
                List<GridRow> rows = new ArrayList<>();

                while (rs.next()) {

                        GridRow row = new GridRow();

                        for (int i = 1; i <= queryResult.getColumns().size(); i++)
                                row.add(stringify(rs.getObject(i), sdf));

                        rows.add(row);
                }

                queryResult.setRows(rows);

                return queryResult;
        }

        private static void setColumns(Connection connection,
                                       SQLParsedStatement ps,
                                       ResultSet rs,
                                       Dialect dialect,
                                       QueryResult queryResult)
                throws SQLException
        {
                Map<String, Column> colMetas = new LinkedHashMap<>();
                ResultSetMetaData rsMeta = rs.getMetaData();

                for (int i = 1; i <= rsMeta.getColumnCount(); i++) {

                        Column c = new Column();

                        c.setIndex(i - 1);

                        c.setLabel(rsMeta.getColumnLabel(i));

                        c.setName(rsMeta.getColumnName(i));

                        c.setType(rsMeta.getColumnTypeName(i));

                        c.setNotNull(
                                rsMeta.isNullable(i) != ResultSetMetaData.columnNullable
                        );

                        colMetas.put(c.getName(), c);

                }

                boolean editable = false;

                if (ps.isSingleTable()) {
                        DatabaseMetaData dbMeta = connection.getMetaData();

                        String singleTable = dialect.removeQuote(ps.getSingleTableName());
                        String cacheKey = connection.getCatalog() + "|" + connection.getSchema() + "|" + singleTable;
                        long now = System.currentTimeMillis();
                        CachedTableMeta cached = TABLE_META_CACHE.get(cacheKey);

                        if (cached == null || now - cached.at() > TABLE_META_TTL_MS) {
                                cached = loadTableMeta(dbMeta, connection.getCatalog(), connection.getSchema(), singleTable, now);

                                if (TABLE_META_CACHE.size() >= TABLE_META_CACHE_LIMIT)
                                        TABLE_META_CACHE.clear();

                                TABLE_META_CACHE.put(cacheKey, cached);
                        }

                        Set<String> pks = cached.primaryKeys();

                        pks.forEach(c -> {

                                Column meta = colMetas.get(c);
                                if (meta != null)
                                        meta.setPrimary(true);

                        });

                        Map<String, Map<String, Object>> columnInfo = cached.columns();

                        for (Column c : colMetas.values()) {
                                Map<String, Object> m = columnInfo.get(c.getName());

                                if (m == null)
                                        continue;

                                c.setAutoIncrement((Boolean) m.get("autoIncrement"));

                                c.setDefaultValue((String) m.get("default"));

                                c.setComment((String) m.get("comment"));
                        }

                        editable = colMetas
                                .values()
                                .stream()
                                .anyMatch(Column::isPrimary);
                }

                queryResult.setEditable(editable);
                queryResult.setColumns(Lists.newArrayList(colMetas.values()));
        }

        /** 读一次表的主键与列元数据（结果按表缓存，见 {@link #TABLE_META_CACHE}） */
        private static CachedTableMeta loadTableMeta(DatabaseMetaData dbMeta, String catalog, String schema,
                                                     String table, long now) throws SQLException
        {
                Set<String> pks = new HashSet<>();

                try (ResultSet pk = dbMeta.getPrimaryKeys(catalog, schema, table)) {
                        while (pk.next())
                                pks.add(pk.getString("COLUMN_NAME"));
                }

                Map<String, Map<String, Object>> columnInfo = new HashMap<>();

                try (ResultSet col = dbMeta.getColumns(catalog, schema, table, "%")) {
                        while (col.next()) {
                                Map<String, Object> m = new HashMap<>();

                                m.put("autoIncrement", "YES".equals(col.getString("IS_AUTOINCREMENT")));
                                m.put("default", col.getString("COLUMN_DEF"));
                                m.put("comment", col.getString("REMARKS"));

                                columnInfo.put(col.getString("COLUMN_NAME"), m);
                        }
                }

                return new CachedTableMeta(pks, columnInfo, now);
        }

        private static String stringify(Object val, SimpleDateFormat sdf)
        {
                if (val == null)
                        return null;

                return switch (val) {
                        case java.sql.Clob clob -> toString(clob);
                        case java.sql.Timestamp ts -> ts.toLocalDateTime().format(formatter);
                        case java.util.Date date -> sdf.format(date);
                        case LocalDateTime date -> date.format(formatter);
                        case byte[] bits -> toBInary(bits);
                        default -> val.toString();
                };
        }

        private static String toString(Clob clob)
        {
                StringBuilder builder = new StringBuilder();

                try (BufferedReader reader = new BufferedReader(clob.getCharacterStream())) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                                builder.append(line);
                        }
                } catch (Exception e) {
                        throw new DriverException(e);
                }

                return builder.toString();
        }

        private static String toBInary(byte[] bytes)
        {
                StringBuilder sb = new StringBuilder(bytes.length * 8);

                for (byte b : bytes)
                        sb.append(BINARY_BYTES[b & 0xFF]);

                return sb.toString();
        }
}
