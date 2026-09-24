package valkyrie.driver.mysql;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import valkyrie.driver.api.*;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.node.DBNode;
import valkyrie.driver.api.node.DBNodeKind;
import valkyrie.driver.api.node.DBNodePath;
import valkyrie.driver.api.sql.SQL;
import valkyrie.driver.api.sql.SQLCommandType;
import valkyrie.driver.suggestion.Suggestion;
import valkyrie.utils.collection.Lists;
import valkyrie.utils.collection.Maps;
import valkyrie.utils.collection.Sets;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.*;

import static valkyrie.utils.TypeConverter.atobool;
import static valkyrie.utils.TypeConverter.atos;
import static valkyrie.utils.collection.Lists.first;
import static valkyrie.utils.collection.Lists.second;
import static valkyrie.utils.string.StrStaticImports.*;

/**
 * MySQL 驱动层实现
 *
 * @author Luo Tiansheng
 * @since 2026/4/11
 */
@SuppressWarnings({"SqlSourceToSinkFlow", "DuplicatedCode"})
public class MySQLDriver extends Driver
{
        private static final Logger LOG = LoggerFactory.getLogger(MySQLDriver.class);

        public MySQLDriver(VkDataSource dataSource)
        {
                super(dataSource);
        }

        @Override
        public DbType getType()
        {
                return DbType.mysql;
        }

        @Override
        public List<DBNode> getNodeHierarchy()
        {
                List<DBNode> catalogNodes = Lists.newArrayList();
                MySQLMetadataProvider metadataProvider = new MySQLMetadataProvider(this);

                List<String> catalogs = getCatalogs();
                for (String catalog : catalogs)
                        catalogNodes.add(new MySQLCatalogNode(catalog, metadataProvider));

                return catalogNodes;
        }

        @Override
        public DBNodePath getNodeHierarchyPath()
        {
                return new DBNodePath(DBNodeKind.CATALOG, null);
        }

        @Override
        protected Dialect createDialect()
        {
                return new MySQLDialect();
        }

        @Override
        public String showCreateTable(Session session, String table)
        {
                QueryResult queryResult = execute(session, new SQL(
                        fmt("SHOW CREATE TABLE %s;", dialect.quote(table))
                ));

                return first(queryResult.getRows()).get(1);
        }

        @Override
        public List<Suggestion> getSuggestions(Session session)
        {
                Set<Suggestion> ret = Sets.newHashSet();

                ret.addAll(MySQLSuggestions.VALUES);

                /* 表信息 */
                List<Table> tables = getTables(session);
                ret.addAll(tables.stream().map(t -> Suggestion.ofClass(t.getName(), t.getComment())).toList());

                /* 字段信息 */
                QueryResult queryResult = execute(session, """
                        SELECT
                          COLUMN_NAME,
                          MAX(COLUMN_COMMENT) AS COLUMN_COMMENT
                        FROM
                          INFORMATION_SCHEMA.COLUMNS
                        WHERE
                          TABLE_SCHEMA = DATABASE()
                        GROUP BY
                          COLUMN_NAME
                        ORDER BY
                          COLUMN_NAME;
                        """);

                ret.addAll(queryResult.getRows().stream().map(t -> Suggestion.ofField(first(t), second(t))).toList());

                return Lists.newArrayList(ret);
        }

        @Override
        public Map<String, List<Column>> getTableColumns(Session session)
        {
                /*
                 * MySQL 走 JDBC 元数据拿不到稳定的列注释，改为直接查 INFORMATION_SCHEMA，
                 * 一次取回所有表的列名、类型与注释，供 SQL 智能提示使用。
                 */
                Map<String, List<Column>> result = new LinkedHashMap<>();

                QueryResult queryResult = execute(session, """
                        SELECT
                          TABLE_NAME,
                          COLUMN_NAME,
                          COLUMN_TYPE,
                          COLUMN_COMMENT
                        FROM
                          INFORMATION_SCHEMA.COLUMNS
                        WHERE
                          TABLE_SCHEMA = DATABASE()
                        ORDER BY
                          TABLE_NAME,
                          ORDINAL_POSITION;
                        """);

                for (GridRow row : queryResult.getRows()) {
                        Column column = new Column();
                        column.setName(row.get(1));
                        column.setType(row.get(2));
                        column.setComment(row.get(3));

                        result.computeIfAbsent(row.get(0), k -> new ArrayList<>()).add(column);
                }

                return result;
        }

        @Override
        public List<Table> getTables(Session session)
        {
                List<Table> tables = Lists.newArrayList();

                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement()) {
                        String sql = fmt("""
                            SELECT
                            	`TABLE_NAME` AS `name`,
                            	`CREATE_TIME` AS `createTime`,
                            	`UPDATE_TIME` AS `updateTime`,
                            	`ENGINE` AS `engine`,
                            	 ROUND((DATA_LENGTH + INDEX_LENGTH), 2) AS `size`,
                            	`TABLE_ROWS` AS `rows`,
                            	`TABLE_COMMENT` AS `comment`
                            FROM
                            	information_schema.TABLES
                            WHERE
                            	TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'BASE TABLE';
                        """, session.catalog());

                        try (var rs = statement.executeQuery(sql)) {
                                while (rs.next()) {
                                        tables.add(new Table(
                                                rs.getString("name"),
                                                rs.getDate("createTime"),
                                                rs.getDate("updateTime"),
                                                rs.getString("engine"),
                                                rs.getFloat("size"),
                                                rs.getInt("rows"),
                                                rs.getString("comment")
                                        ));
                                }
                        }
                } catch (SQLException e) {
                        throw new DriverException(e);
                }

                return tables;
        }

        @Override
        public List<Table> getViews(Session session)
        {
                List<Table> views = Lists.newArrayList();

                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement()) {
                        String sql = fmt("""
                            SELECT
                            	`TABLE_NAME` AS `name`,
                            	`TABLE_COMMENT` AS `comment`
                            FROM
                            	information_schema.TABLES
                            WHERE
                            	TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'VIEW';
                        """, session.catalog());

                        try (var rs = statement.executeQuery(sql)) {
                                while (rs.next()) {
                                        Table view = new Table(rs.getString("name"));
                                        view.setComment(rs.getString("comment"));
                                        views.add(view);
                                }
                        }
                } catch (SQLException e) {
                        throw new DriverException(e);
                }

                return views;
        }

        @Override
        public List<Table> getTriggers(Session session)
        {
                List<Table> triggers = Lists.newArrayList();

                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement()) {
                        String sql = fmt("""
                            SELECT
                            	`TRIGGER_NAME` AS `name`,
                            	`CREATED` AS `createTime`,
                            	`ACTION_TIMING` AS `timing`,
                            	`EVENT_MANIPULATION` AS `event`,
                            	`EVENT_OBJECT_TABLE` AS `table`
                            FROM
                            	information_schema.TRIGGERS
                            WHERE
                            	TRIGGER_SCHEMA = '%s';
                        """, session.catalog());

                        try (var rs = statement.executeQuery(sql)) {
                                while (rs.next()) {
                                        Table trigger = new Table(rs.getString("name"));
                                        trigger.setCreateTime(rs.getTimestamp("createTime"));
                                        trigger.setComment(fmt("%s %s ON %s",
                                                rs.getString("timing"), rs.getString("event"), rs.getString("table")));
                                        triggers.add(trigger);
                                }
                        }
                } catch (SQLException e) {
                        throw new DriverException(e);
                }

                return triggers;
        }

        @Override
        public List<ForeignKey> getForeignKeys(Session session, String table)
        {
                Map<String, ForeignKey> keys = new LinkedHashMap<>();

                String sql = fmt("""
                    SELECT
                    	`CONSTRAINT_NAME` AS `name`,
                    	`COLUMN_NAME` AS `column`,
                    	`REFERENCED_TABLE_NAME` AS `refTable`,
                    	`REFERENCED_COLUMN_NAME` AS `refColumn`
                    FROM
                    	information_schema.KEY_COLUMN_USAGE
                    WHERE
                    	`TABLE_SCHEMA` = '%s' AND `TABLE_NAME` = '%s'
                    	AND `REFERENCED_TABLE_NAME` IS NOT NULL
                    ORDER BY
                    	`CONSTRAINT_NAME`, `ORDINAL_POSITION`;
                """, session.catalog(), table.replace("'", "''"));

                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement();
                     var rs = statement.executeQuery(sql)) {
                        while (rs.next()) {
                                String name = rs.getString("name");
                                ForeignKey key = keys.computeIfAbsent(name, k -> {
                                        ForeignKey created = new ForeignKey();
                                        created.setName(k);
                                        created.setColumns(new ArrayList<>());
                                        created.setRefColumns(new ArrayList<>());
                                        return created;
                                });

                                key.getColumns().add(rs.getString("column"));
                                key.setRefTable(rs.getString("refTable"));
                                key.getRefColumns().add(rs.getString("refColumn"));
                        }
                } catch (SQLException e) {
                        throw new DriverException(e);
                }

                return Lists.newArrayList(keys.values());
        }

        @Override
        public List<Index> getIndexes(Session session, String table)
        {
                SQL sql = new SQL("SHOW INDEX FROM " + dialect.quote(table) + ";");

                QueryResult queryResult = execute(session, sql);

                Map<String, List<String>> indexColumns = Maps.newHashMap();
                Map<String, Index> indexes = new LinkedHashMap<>();

                for (int i = 0; i < queryResult.size(); i++) {
                        String keyName = queryResult.getRowValue(i, "Key_name");
                        List<String> columns = indexColumns.computeIfAbsent(keyName, k -> new ArrayList<>());

                        /* 主键忽略 */
                        if (streq(keyName, "PRIMARY"))
                                continue;

                        columns.add(queryResult.getRowValue(i, "Column_name"));

                        Index index = new Index();

                        index.setName(keyName);
                        index.setOriginalName(keyName);

                        String Non_unique = queryResult.getRowValue(i, "Non_unique");
                        String Index_type = queryResult.getRowValue(i, "Index_type");

                        if (streq(Non_unique, "1") && streq(Index_type, "BTREE")) {
                                index.setType("NORMAL");
                        } else if (streq(Non_unique, "0") && streq(Index_type, "BTREE")) {
                                index.setType("UNIQUE");
                        } else if (streq(Index_type, "FULLTEXT")) {
                                index.setType("FULLTEXT");
                        } else if (streq(Index_type, "SPATIAL")) {
                                index.setType("SPATIAL");
                        } else if (streq(Index_type, "HASH")) {
                                index.setType("HASH");
                        } else {
                                index.setType(Index_type);
                        }

                        if (productMetaData.getMajorVersion() >= MySQL.VERSION_8x) {
                                index.setVisible(atobool(queryResult.getRowValue(i, "Visible")));
                                index.setOriginalVisible(index.isVisible());
                        }

                        indexes.put(index.getName(), index);
                }

                List<Index> ret = Lists.newArrayList(indexes.values());

                ret.forEach(idx -> {
                        /* 生成索引列 */
                        idx.generateColumnText(indexColumns.get(idx.getName()));
                        /* 生成完整性校验码 */
                        idx.finalIntegrityCode();
                });

                return ret;
        }

        @Override
        public Set<String> getIndexTypes()
        {
                return Sets.newLinkedHashSet(
                        "NORMAL",
                        "UNIQUE",
                        "FULLTEXT",
                        "SPATIAL",
                        "HASH"
                );
        }

        @Override
        public void dropTable(Session session, String table)
        {
                execute(session, "DROP TABLE `%s`;", dialect.quote(table));
        }

        @Override
        public void dropColumns(Session session, String table, Collection<Column> columns)
        {
                StringBuilder script = new StringBuilder();

                script.append(fmt("ALTER TABLE `%s` ", table));

                for (Column col : columns)
                        script.append(fmt("DROP COLUMN `%s`, ", col.getName()));

                script.delete(script.length() - 2, script.length());
                script.append(";");

                execute(session, new SQL(atos(script)));
        }

        @Override
        public void dropIndexKeys(Session session, String table, Collection<Index> selectionItems)
        {
                StringBuilder scripts = new StringBuilder();

                for (Index index : selectionItems) {

                        String name = streq(index.getName(), index.getOriginalName())
                                ? index.getName()
                                : index.getOriginalName();

                        scripts.append(
                                fmt("ALTER TABLE `%s` DROP INDEX `%s`;\n", table, name)
                        );
                }

                execute(session, new SQL(atos(scripts)));
        }

        @Override
        public void dropPrimaryKey(Session session, String table)
        {
                try {
                        execute(session, new SQL(fmt("ALTER TABLE %s DROP PRIMARY KEY;", dialect.quote(table))));
                } catch (DriverException e) {
                        if (e.getErrorCode() == 1091)
                                return;
                        throw e;
                }
        }

        @Override
        public void addPrimaryKey(Session session, String table, Collection<Column> primaryKeys)
        {
                if (primaryKeys.isEmpty())
                        return;

                StringBuilder script = new StringBuilder();
                script.append("ALTER TABLE ").append(dialect.quote(table)).append(" ADD PRIMARY KEY (");

                for (Column primaryKey : primaryKeys) {
                        script.append(dialect.quote(primaryKey.getName())).append(",");
                }

                script.delete(script.length() - 1, script.length());
                script.append(");");

                execute(session, new SQL(atos(script)));
        }

        @Override
        public void alterIndexKeys(Session session, String table, Collection<Index> indexes)
        {
                StringBuilder scripts = new StringBuilder();

                for (Index index : indexes) {

                        String type = index.getType();
                        String name = index.getName();
                        String columns = index.getColumnsText();

                        if (streq(type, "NORMAL")) {
                                scripts.append(
                                        fmt(
                                                "CREATE INDEX `%s` ON `%s`(%s);\n",
                                                name,
                                                table,
                                                columns
                                        )
                                );
                                continue;
                        }

                        if (streq(type, "UNIQUE")) {
                                scripts.append(
                                        fmt(
                                                "CREATE UNIQUE INDEX `%s` ON `%s`(%s);\n",
                                                name,
                                                table,
                                                columns
                                        )
                                );
                                continue;
                        }

                        if (streq(type, "FULLTEXT")) {
                                scripts.append(
                                        fmt(
                                                "CREATE FULLTEXT INDEX `%s` ON `%s`(%s);\n",
                                                name,
                                                table,
                                                columns
                                        )
                                );
                                continue;
                        }

                        if (streq(type, "SPATIAL")) {
                                scripts.append(
                                        fmt(
                                                "CREATE SPATIAL INDEX `%s` ON `%s`(%s);\n",
                                                name,
                                                table,
                                                columns
                                        )
                                );
                                continue;
                        }

                        if (streq(type, "HASH")) {
                                scripts.append(
                                        fmt(
                                                "CREATE INDEX `%s` ON `%s`(%s) USING HASH;\n",
                                                name,
                                                table,
                                                columns
                                        )
                                );
                        }
                }

                execute(session, new SQL(SQLCommandType.EXECUTE, atos(scripts)));
        }

        @Override
        public void alterChange(Session session, String table, Collection<Column> columns)
        {
                if (Lists.isEmpty(columns))
                        return;

                StringBuilder builder = new StringBuilder();

                for (Column col : columns) {
                        StringBuilder definition = new StringBuilder();

                        definition.append(dialect.quote(col.getName())).append(' ').append(col.getType());
                        definition.append(col.isNotNull() ? " NOT NULL" : " NULL");

                        if (col.isAutoIncrement())
                                definition.append(" AUTO_INCREMENT");

                        if (strnempty(col.getDefaultValue()))
                                definition.append(" DEFAULT ").append(col.getDefaultValue());

                        if (col.getComment() != null)
                                definition.append(" COMMENT '").append(col.getComment()).append("'");

                        if (col.getOriginalName() != null)
                                builder.append("ALTER TABLE ").append(dialect.quote(table))
                                        .append(" CHANGE `").append(col.getOriginalName()).append("` ")
                                        .append(definition).append(";");
                        else
                                builder.append("ALTER TABLE ").append(dialect.quote(table))
                                        .append(" ADD ").append(definition).append(";");
                }

                execute(session, new SQL(atos(builder)));
        }

        @Override
        public void alterVisible(Session session, String table, Collection<Index> indexes)
        {
                StringBuilder scripts = new StringBuilder();

                for (Index index : indexes) {
                        String isVisible = index.isVisible() ? "VISIBLE" : "INVISIBLE";
                        scripts.append(
                                fmt("ALTER TABLE %s ALTER INDEX %s %s;",
                                        dialect.quote(table),
                                        dialect.quote(index.getName()),
                                        isVisible)
                        );
                }

                execute(session, new SQL(atos(scripts)));
        }
}
