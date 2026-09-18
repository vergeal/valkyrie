package valkyrie.driver.postgresql;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import valkyrie.driver.api.*;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.node.DBNode;
import valkyrie.driver.api.node.DBNodeKind;
import valkyrie.driver.api.node.DBNodePath;
import valkyrie.driver.suggestion.Suggestion;
import valkyrie.driver.utils.JdbcUtils;
import valkyrie.utils.bean.BeanUtils;
import valkyrie.utils.collection.Lists;
import valkyrie.utils.collection.Sets;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

import static valkyrie.utils.collection.Lists.first;
import static valkyrie.utils.collection.Lists.second;
import static valkyrie.utils.string.StrStaticImports.fmt;

/**
 * Postgresql 驱动层实现
 *
 * @author Luo Tiansheng
 * @since 2026/6/04
 */
@SuppressWarnings({"SqlSourceToSinkFlow", "DuplicatedCode"})
public class PostgresqlDriver extends Driver
{
        private static final Logger LOG = LoggerFactory.getLogger(PostgresqlDriver.class);

        private final String defaultKey = "__init_default__";
        private final Map<String, VkDataSource> dataSourceManager = new ConcurrentHashMap<>();

        private Set<String> indexTypes;

        public PostgresqlDriver(VkDataSource dataSource)
        {
                super(dataSource);
                dataSourceManager.put(defaultKey, dataSource);
        }

        @Override
        public DbType getType()
        {
                return DbType.postgresql;
        }

        @Override
        public void closeDataSources()
        {
                for (VkDataSource source : dataSourceManager.values()) {
                        try {
                                source.close();
                        } catch (Exception e) {
                                LOG.warn("关闭数据源失败", e);
                        }
                }

                dataSourceManager.clear();
        }

        @Override
        public List<DBNode> getNodeHierarchy()
        {
                List<DBNode> catalogNodes = Lists.newArrayList();
                PostgresqlMetadataProvider metadataProvider = new PostgresqlMetadataProvider(this);

                List<String> catalogs = getCatalogs();
                for (String catalog : catalogs)
                        catalogNodes.add(new PostgresqlCatalogNode(catalog, metadataProvider));

                return catalogNodes;
        }

        @Override
        public DBNodePath getNodeHierarchyPath()
        {
                return new DBNodePath(DBNodeKind.CATALOG,
                        new DBNodePath(DBNodeKind.SCHEMA, null));
        }

        @Override
        protected Dialect createDialect()
        {
                return new PostgresqlDialect();
        }

        public Connection getConnection(Session session) throws SQLException
        {
                dataSource = dataSourceManager.get(defaultKey);

                if (session != null && session.catalog() != null)
                        dataSource = dataSourceManager.get(session.catalog());

                return super.getConnection(session);
        }

        @Override
        public String showCreateTable(Session session, String table)
        {
                String schema = session.schema();
                String quotedTable = dialect.quote(table);
                StringBuilder ddl = new StringBuilder();

                // 1. 获取列定义
                String columnsSql = fmt("""
                        SELECT
                          a.attname AS column_name,
                          pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                          NOT a.attnotnull AS is_nullable,
                          pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS column_default,
                          col_description(c.oid, a.attnum) AS column_comment
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        JOIN pg_attribute a ON a.attrelid = c.oid
                        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
                        WHERE c.relname = '%s'
                          AND n.nspname = '%s'
                          AND a.attnum > 0
                          AND NOT a.attisdropped
                        ORDER BY a.attnum;
                        """, table, schema);

                List<String> columnDefs = new ArrayList<>();
                try (Connection conn = getConnection(session);
                     Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery(columnsSql)) {
                        while (rs.next()) {
                                String colName = dialect.quote(rs.getString("column_name"));
                                String dataType = rs.getString("data_type");
                                String nullable = rs.getBoolean("is_nullable") ? "" : " NOT NULL";
                                String defaultValue = rs.getString("column_default");
                                String defaultClause = (defaultValue != null) ? " DEFAULT " + defaultValue : "";
                                columnDefs.add(colName + " " + dataType + defaultClause + nullable);
                        }
                } catch (SQLException e) {
                        throw new DriverException(e);
                }

                if (columnDefs.isEmpty())
                        return "";

                ddl.append("CREATE TABLE ").append(dialect.quote(schema)).append(".").append(quotedTable).append(" (\n  ");
                ddl.append(String.join(",\n  ", columnDefs));

                // 2. 获取主键约束
                String pkSql = fmt("""
                        SELECT
                            con.conname AS constraint_name,
                            string_agg(attname, ',' ORDER BY attnum) AS pk_columns
                        FROM pg_constraint con
                        JOIN pg_class c ON c.oid = con.conrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
                        WHERE c.relname = '%s'
                          AND n.nspname = '%s'
                          AND con.contype = 'p'
                        GROUP BY con.conname;
                        """, table, schema);

                try (Connection conn = getConnection(session);
                     Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery(pkSql)) {
                        if (rs.next()) {
                                String pkColumns = rs.getString("pk_columns");
                                ddl.append(",\n  PRIMARY KEY (").append(pkColumns).append(")");
                        }
                } catch (SQLException e) {
                        LOG.warn("Failed to get primary key for table {}", table, e);
                }

                ddl.append("\n);");
                return ddl.toString();
        }

        @Override
        public List<String> getCatalogs()
        {
                String sql = """
                        SELECT datname
                        FROM pg_database
                        WHERE has_database_privilege(datname, 'CONNECT')
                        AND NOT datistemplate
                        ORDER BY datname;
                        """;

                QueryResult rs = execute(new Session(), sql);

                List<String> catalogs = rs.getRows().stream()
                        .map(Lists::first)
                        .toList();

                VkDataSource ds = dataSourceManager.get(defaultKey);
                ConnectionConfig cnf = ds.getConnectionConfig();

                for (String catalog : catalogs) {
                        /* 已经为该库建过池就直接复用：刷新对象树会反复调用本方法，重复建池会泄漏连接 */
                        if (dataSourceManager.containsKey(catalog))
                                continue;

                        ConnectionConfig cc =
                                BeanUtils.copyProperties(cnf, ConnectionConfig.class);
                        String jdbcUrl = JdbcUtils.updateDefaultDatabase(cc.getJdbcUrl(), catalog);
                        cc.setJdbcUrl(jdbcUrl);
                        dataSourceManager.put(catalog, new PooledDataSource(cc));
                }

                return catalogs;
        }

        @Override
        public List<String> getSchemas(Session session)
        {
                return super.getSchemas(session);
        }

        @Override
        public List<Suggestion> getSuggestions(Session session)
        {
                Set<Suggestion> ret = Sets.newHashSet();

                ret.addAll(PostgresqlSuggestions.VALUES);

                /* 表信息 */
                List<Table> tables = getTables(session);
                ret.addAll(tables.stream()
                        .map(t -> Suggestion.ofClass(t.getName(), t.getComment()))
                        .toList());

                /* 字段信息 */
                QueryResult queryResult = execute(session, """
                        SELECT
                          c.column_name,
                          MAX(pd.description) AS comment
                        FROM
                          information_schema.columns c
                          LEFT JOIN pg_catalog.pg_class pc
                            ON pc.relname = c.table_name
                          LEFT JOIN pg_catalog.pg_namespace pn
                            ON pn.oid = pc.relnamespace
                            AND pn.nspname = c.table_schema
                          LEFT JOIN pg_catalog.pg_attribute pa
                            ON pa.attrelid = pc.oid
                            AND pa.attname = c.column_name
                          LEFT JOIN pg_catalog.pg_description pd
                            ON pd.objoid = pc.oid
                            AND pd.objsubid = pa.attnum
                        WHERE
                          c.table_schema = '%s'
                        GROUP BY
                          c.column_name
                        """, session.schema());

                ret.addAll(queryResult.getRows().stream()
                        .map(t -> Suggestion.ofField(first(t), second(t)))
                        .toList());

                return Lists.newArrayList(ret);
        }

        @Override
        public List<Table> getTables(Session session)
        {
                List<Table> ret = Lists.newArrayList();

                String sql = fmt("""
                        SELECT
                          c.relname AS name,
                          NULL::timestamp AS create_time,
                          NULL::timestamp AS update_time,
                          'PostgreSQL' AS engine,
                          pg_total_relation_size(c.oid) AS size,
                          c.reltuples::bigint AS rows,
                          obj_description(c.oid, 'pg_class') AS comment
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        JOIN pg_tables t ON c.relname = t.tablename
                        WHERE c.relkind = 'r'
                          AND n.nspname = '%s'
                        ORDER BY c.relname;
                        """, session.schema());

                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement()) {
                        ResultSet r = statement.executeQuery(sql);
                        while (r.next()) {
                                ret.add(new Table(
                                        r.getString("name"),
                                        r.getDate("create_time"),
                                        r.getDate("update_time"),
                                        r.getString("engine"),
                                        r.getFloat("size"),
                                        r.getInt("rows"),
                                        r.getString("comment")
                                ));
                        }
                } catch (Exception e) {
                        throw new DriverException(e);
                }

                return ret;
        }

        @Override
        @SuppressWarnings("ExtractMethodRecommender")
        public List<Index> getIndexes(Session session, String table)
        {
                String sql = fmt("""
                        SELECT
                          idx_class.relname AS name,
                          (
                            SELECT string_agg(pg_get_indexdef(idx_class.oid, n, true), ', ')
                            FROM generate_series(1, pg_index.indnkeyatts) n
                          ) AS columns_text,
                          am.amname AS type,
                          pg_index.indisvalid AS visible
                        FROM
                          pg_class tbl
                          JOIN pg_index ON tbl.oid = pg_index.indrelid
                          JOIN pg_class idx_class ON pg_index.indexrelid = idx_class.oid
                          JOIN pg_am am ON idx_class.relam = am.oid
                        WHERE
                          tbl.relname = '%s'
                          AND tbl.relkind = 'r';
                        """, table);

                QueryResult rs = execute(session, sql);

                List<Index> ret = Lists.newArrayList();

                for (GridRow row : rs.getRows()) {
                        Index index = new Index();
                        index.setName(row.get(0));
                        index.setColumnsText(row.get(1));
                        index.setType(row.get(2));
                        index.setVisible(Boolean.parseBoolean(row.get(3)));
                        index.setOriginalName(index.getName());
                        index.setOriginalVisible(index.isVisible());
                        ret.add(index);
                }

                return ret;
        }

        @Override
        public Set<String> getIndexTypes()
        {
                if (indexTypes == null) {
                        QueryResult rs = execute("SELECT amname FROM pg_am;");
                        indexTypes = rs.getRows().stream()
                                .map(Lists::first)
                                .collect(Collectors.toSet());
                }

                return indexTypes;
        }

        @Override
        public void dropTable(Session session, String table)
        {

        }

        @Override
        public void dropColumns(Session session, String table, Collection<Column> columns)
        {

        }

        @Override
        public void dropIndexKeys(Session session, String table, Collection<Index> selectionItems)
        {

        }

        @Override
        public void dropPrimaryKey(Session session, String table)
        {

        }

        @Override
        public void addPrimaryKey(Session session, String table, Collection<Column> primaryKeys)
        {

        }

        @Override
        public void alterIndexKeys(Session session, String table, Collection<Index> indexes)
        {

        }

        @Override
        public void alterChange(Session session, String table, Collection<Column> columns)
        {

        }

        @Override
        public void alterVisible(Session session, String table, Collection<Index> indexes)
        {

        }
}
