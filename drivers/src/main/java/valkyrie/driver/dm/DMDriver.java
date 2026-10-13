package valkyrie.driver.dm;

import valkyrie.driver.api.*;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.node.DBNode;
import valkyrie.driver.api.node.DBNodeKind;
import valkyrie.driver.api.node.DBNodePath;
import valkyrie.driver.api.sql.SQL;
import valkyrie.driver.suggestion.Suggestion;
import valkyrie.utils.Captor;
import valkyrie.utils.collection.Lists;
import valkyrie.utils.collection.Sets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.Collection;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;

import static valkyrie.utils.TypeConverter.atobool;
import static valkyrie.utils.TypeConverter.atos;
import static valkyrie.utils.collection.Lists.first;
import static valkyrie.utils.collection.Lists.second;
import static valkyrie.utils.string.StrStaticImports.*;

/**
 * @author Luo Tiansheng
 * @since 2026/4/13
 */
@SuppressWarnings("SqlSourceToSinkFlow")
public class DMDriver extends Driver
{
        /*
         * 达梦字典视图一次扫描要好几秒，主键与外键两条并行能省一半时间。
         * 这里用自己的小线程池，而不是公共 ThreadPool：公共池里可能已经有任务在等
         * 自己提交的子任务，嵌套等待会把池子占死（踩过一次，界面直接卡住）。
         */
        private static final ExecutorService DIAGRAM_POOL = Executors.newFixedThreadPool(2, new ThreadFactory()
        {
                private int sequence;

                @Override
                public Thread newThread(Runnable runnable)
                {
                        Thread thread = new Thread(runnable, "dm-metadata-" + (++sequence));

                        thread.setDaemon(true);
                        return thread;
                }
        });

        public DMDriver(VkDataSource dataSource)
        {
                super(dataSource);
        }

        @Override
        public DbType getType()
        {
                return DbType.dm;
        }

        @Override
        public List<DBNode> getNodeHierarchy()
        {
                List<DBNode> schemaNodes = Lists.newArrayList();
                DMMetadataProvider metadataProvider = new DMMetadataProvider(this);
                
                List<String> schemas = getSchemas();
                for (String schema : schemas)
                        schemaNodes.add(new DMSchemaNode(schema, metadataProvider));

                return schemaNodes;
        }

        @Override
        public DBNodePath getNodeHierarchyPath()
        {
                return new DBNodePath(DBNodeKind.SCHEMA, null);
        }

        @Override
        protected Dialect createDialect()
        {
                return new DMDialect();
        }

        @Override
        public String showCreateTable(Session session, String table)
        {
                QueryResult queryResult = execute(session, new SQL(
                        fmt("""
                                SELECT DMDBA.GET_DDL_FIX('TABLE', '%s', '%s') AS "DDL" FROM DUAL
                                """, table, session.schema())
                ));

                return first(first(queryResult.getRows()));
        }

        @Override
        public List<Suggestion> getSuggestions(Session session)
        {
                Set<Suggestion> ret = Sets.newHashSet();

                ret.addAll(DMSuggestions.VALUES);

                /* 表信息 */
                List<Table> tables = getTables(session);
                ret.addAll(tables.stream().map(t -> Suggestion.ofClass(t.getName(), t.getComment())).toList());

                /* 字段信息 */
                QueryResult queryResult = execute(session, """
                        SELECT
                          c.COLUMN_NAME,
                          MAX(cc.COMMENTS) as "COMMENT"
                        FROM
                          ALL_TAB_COLUMNS c
                          LEFT JOIN ALL_COL_COMMENTS cc ON c.OWNER = cc.OWNER
                          AND c.TABLE_NAME = cc.TABLE_NAME
                          AND c.COLUMN_NAME = cc.COLUMN_NAME
                        WHERE
                          c.OWNER = 'OPENSER'
                        GROUP BY
                          c.COLUMN_NAME;
                        """, session.schema());

                ret.addAll(queryResult.getRows().stream().map(t -> Suggestion.ofField(first(t), second(t))).toList());

                return Lists.newArrayList(ret);
        }

        @Override
        public List<Table> getTables(Session session)
        {
                List<Table> tables = Lists.newArrayList();

                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement()) {
                        String sql = """
                                    SELECT
                                        t.TABLE_NAME AS name,
                                        o.CRTDATE AS createTime,
                                        TABLE_ROWCOUNT('%s', t.TABLE_NAME) AS "rows",
                                        TABLE_USED_SPACE('%s', t.TABLE_NAME) AS usedPages,
                                        c.COMMENTS AS "comment",
                                        (SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME = 'GLOBAL_PAGE_SIZE') AS pageSize
                                    FROM
                                        ALL_TABLES t
                                        LEFT JOIN ALL_TAB_COMMENTS c
                                            ON t.OWNER = c.OWNER AND t.TABLE_NAME = c.TABLE_NAME
                                        LEFT JOIN SYS.SYSOBJECTS o
                                            ON o.NAME = t.TABLE_NAME
                                            AND o.SCHID = (SELECT ID FROM SYS.SYSOBJECTS WHERE NAME = '%s' AND TYPE$ = 'SCH')
                                            AND o.SUBTYPE$ IN ('UTAB', 'STAB')
                                    WHERE
                                        t.OWNER = '%s'
                                """.formatted(session.schema(), session.schema(), session.schema(), session.schema());

                        try (var rs = statement.executeQuery(sql)) {
                                int pageSize = 0;
                                boolean pageSizeFetched = false;

                                while (rs.next()) {
                                        // 获取页大小（同一结果集中每行都相同，只需取一次）
                                        if (!pageSizeFetched) {
                                                pageSize = rs.getInt("pageSize");
                                                pageSizeFetched = true;
                                        }

                                        // 计算表大小（字节）
                                        long usedPages = rs.getLong("usedPages");
                                        float sizeInBytes = (usedPages * pageSize);

                                        // 处理创建时间
                                        Timestamp createTimestamp = rs.getTimestamp("createTime");
                                        Date createDate = createTimestamp != null ? new Date(createTimestamp.getTime()) : null;

                                        tables.add(new Table(
                                                rs.getString("name"),
                                                createDate,
                                                null,
                                                null,
                                                sizeInBytes,
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

        /**
         * ER 图专用：只读字段名 / 类型 / 是否非空，不碰注释。
         * <p>
         * 达梦的 {@code ALL_COL_COMMENTS} 单查一次要 4 秒（JDBC 的 getColumns 会带上它），
         * 而 ER 图不需要注释，所以这里直接用 {@code ALL_TAB_COLUMNS}。
         */
        @Override
        public Map<String, List<Column>> getDiagramColumns(Session session)
        {
                Map<String, List<Column>> columns = new LinkedHashMap<>();

                QueryResult result = execute(session, """
                        SELECT
                          T.TABLE_NAME AS TABLE_NAME,
                          T.COLUMN_NAME AS COLUMN_NAME,
                          T.DATA_TYPE AS DATA_TYPE,
                          T.NULLABLE AS NULLABLE
                        FROM
                          ALL_TAB_COLUMNS T
                        WHERE
                          T.OWNER = '%s'
                        ORDER BY
                          T.TABLE_NAME, T.COLUMN_ID
                        ;
                        """, session.schema());

                for (int i = 0; i < result.size(); i++) {
                        Column column = new Column();
                        column.setName(result.getRowValue(i, "COLUMN_NAME"));
                        column.setType(result.getRowValue(i, "DATA_TYPE"));
                        column.setNotNull("N".equals(result.getRowValue(i, "NULLABLE")));

                        columns.computeIfAbsent(result.getRowValue(i, "TABLE_NAME"), key -> Lists.newArrayList())
                                .add(column);
                }

                return columns;
        }

        /**
         * ER 图：一条 SQL 取回当前模式下的主键，另一条取回外键。
         * <p>
         * 达梦是 Oracle 兼容字典：{@code USER_CONSTRAINTS} + {@code USER_CONS_COLUMNS}，
         * 外键靠 {@code R_CONSTRAINT_NAME} 找回被引用的主键字段。逐表读 JDBC 元数据
         * 在远端库上要几十秒，这里两次往返就够。
         */
        @Override
        public TableRelations getTableRelations(Session session)
        {
                TableRelations relations = new TableRelations();

                /*
                 * 达梦的字典视图一次扫描要好几秒，主键与外键两条分别查的话就是两倍；
                 * 两条互不依赖，放到线程池里同时跑。
                 */
                Future<QueryResult> primaryTask = DIAGRAM_POOL.submit(() -> execute(session, """
                        SELECT
                          C.TABLE_NAME AS TABLE_NAME,
                          CC.COLUMN_NAME AS COLUMN_NAME
                        FROM
                          ALL_CONSTRAINTS C
                          JOIN ALL_CONS_COLUMNS CC
                            ON CC.OWNER = C.OWNER
                           AND CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME
                           AND CC.TABLE_NAME = C.TABLE_NAME
                        WHERE
                          C.CONSTRAINT_TYPE = 'P'
                          AND C.OWNER = '%s'
                        ORDER BY
                          C.TABLE_NAME, CC.POSITION
                        ;
                        """, session.schema()));

                Future<QueryResult> foreignTask = DIAGRAM_POOL.submit(() -> execute(session, """
                        SELECT
                          C.TABLE_NAME AS TABLE_NAME,
                          C.CONSTRAINT_NAME AS CONSTRAINT_NAME,
                          CC.COLUMN_NAME AS COLUMN_NAME,
                          RC.TABLE_NAME AS REF_TABLE,
                          RC.OWNER AS REF_OWNER,
                          RCC.COLUMN_NAME AS REF_COLUMN
                        FROM
                          ALL_CONSTRAINTS C
                          JOIN ALL_CONSTRAINTS RC
                            ON RC.OWNER = C.R_OWNER
                           AND RC.CONSTRAINT_NAME = C.R_CONSTRAINT_NAME
                          JOIN ALL_CONS_COLUMNS CC
                            ON CC.OWNER = C.OWNER
                           AND CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME
                           AND CC.TABLE_NAME = C.TABLE_NAME
                          JOIN ALL_CONS_COLUMNS RCC
                            ON RCC.OWNER = RC.OWNER
                           AND RCC.CONSTRAINT_NAME = RC.CONSTRAINT_NAME
                           AND RCC.TABLE_NAME = RC.TABLE_NAME
                           AND RCC.POSITION = CC.POSITION
                        WHERE
                          C.CONSTRAINT_TYPE = 'R'
                          AND C.OWNER = '%s'
                        ORDER BY
                          C.TABLE_NAME, C.CONSTRAINT_NAME, CC.POSITION
                        ;
                        """, session.schema()));

                QueryResult primary = await(primaryTask);
                QueryResult foreign = await(foreignTask);

                for (int i = 0; i < primary.size(); i++)
                        relations.addPrimaryKey(
                                primary.getRowValue(i, "TABLE_NAME"),
                                primary.getRowValue(i, "COLUMN_NAME"));

                for (int i = 0; i < foreign.size(); i++)
                        relations.addForeignKey(
                                foreign.getRowValue(i, "TABLE_NAME"),
                                foreign.getRowValue(i, "CONSTRAINT_NAME"),
                                foreign.getRowValue(i, "COLUMN_NAME"),
                                foreign.getRowValue(i, "REF_TABLE"),
                                foreign.getRowValue(i, "REF_COLUMN"),
                                null, foreign.getRowValue(i, "REF_OWNER"));

                return relations;
        }

        /** 取并发查询结果：失败按驱动异常抛出，避免半张图悄悄少数据 */
        private static QueryResult await(Future<QueryResult> task)
        {
                try {
                        return task.get();
                } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new DriverException(e);
                } catch (ExecutionException e) {
                        throw new DriverException(e.getCause() == null ? e : e.getCause());
                }
        }

        @Override
        public List<Index> getIndexes(Session session, String table)
        {
                var sql = """
                        SELECT
                          I.INDEX_NAME,
                          WM_CONCAT(IC.COLUMN_NAME) AS COLUMNS_TEXT,
                          CASE
                              WHEN I.UNIQUENESS = 'UNIQUE' AND I.INDEX_TYPE = 'NORMAL' THEN 'UNIQUE'
                              ELSE UPPER(I.INDEX_TYPE)
                          END AS INDEX_TYPE,
                          CASE WHEN I.STATUS = 'VALID' THEN 'ON' ELSE 'OFF' END AS VISIBLE
                        FROM
                          USER_INDEXES I
                          JOIN USER_IND_COLUMNS IC
                              ON I.INDEX_NAME = IC.INDEX_NAME
                              AND I.TABLE_NAME = IC.TABLE_NAME
                        WHERE
                          I.TABLE_NAME = '%s'
                          AND INDEX_TYPE != 'VIRTUAL'
                          AND I.INDEX_NAME NOT LIKE 'ROWID%%'
                          AND I.INDEX_NAME NOT IN (
                            SELECT INDEX_NAME FROM USER_CONSTRAINTS
                              WHERE TABLE_NAME = '%s'
                                AND CONSTRAINT_TYPE = 'P'
                          )
                        GROUP BY
                          I.INDEX_NAME, I.UNIQUENESS, I.INDEX_TYPE, I.STATUS
                        ;
                        """;

                QueryResult queryResult = execute(session, sql, table, table);

                List<Index> indexes = Lists.newArrayList();
                for (int i = 0; i < queryResult.size(); i++) {
                        Index index = new Index();
                        index.setName(queryResult.getRowValue(i, 0));
                        index.setColumnsText(queryResult.getRowValue(i, 1));
                        index.setType(queryResult.getRowValue(i, 2));
                        index.setVisible(atobool(queryResult.getRowValue(0, 3)));
                        index.setOriginalName(index.getName());
                        index.setOriginalVisible(index.isVisible());
                        index.finalIntegrityCode();
                        indexes.add(index);
                }

                return indexes;
        }

        @Override
        public Set<String> getIndexTypes()
        {
                return Sets.newLinkedHashSet(
                        DMIndexType.NORMAL.name(),
                        DMIndexType.UNIQUE.name(),
                        DMIndexType.BITMAP.name()
                );
        }

        @Override
        public void dropTable(Session session, String table)
        {
                execute(session, "DROP TABLE %s", dialect.quote(table));
        }

        @Override
        public void dropColumns(Session session, String table, Collection<Column> columns)
        {
                StringBuilder deleteColumnBuilder = new StringBuilder();

                for (Column column : columns) {
                        deleteColumnBuilder.append(fmt("ALTER TABLE %s.%s DROP COLUMN %s;",
                                dialect.quote(session.schema()),
                                dialect.quote(table),
                                dialect.quote(column.getOriginalName())));
                }

                execute(session, deleteColumnBuilder);
        }

        @Override
        public void dropIndexKeys(Session session, String table, Collection<Index> selectionItems)
        {
                StringBuilder batch = new StringBuilder();

                for (Index selectionItem : selectionItems) {
                        var sqlText = fmt("DROP INDEX IF EXISTS %s.%s;",
                                dialect.quote(session.schema()),
                                dialect.quote(selectionItem.getLatestName()));
                        batch.append(sqlText);
                }

                execute(session, batch);
        }

        @SuppressWarnings("TrailingWhitespacesInTextBlock")
        private String getConstraintId(Session session, String table)
        {
                var sql = fmt("""
                        SELECT
                          CONSTRAINT_NAME
                        FROM
                          USER_CONSTRAINTS 
                        WHERE 1=1
                          AND TABLE_NAME = '%s' 
                          AND CONSTRAINT_TYPE = 'P'
                          AND INDEX_OWNER = '%s'
                        ;
                        """, table, session.schema());

                QueryResult queryResult = execute(session, sql);
                return queryResult.getRowValue(0, 0);
        }

        @Override
        public void dropPrimaryKey(Session session, String table)
        {
                String constraintId = getConstraintId(session, table);

                if (strempty(constraintId))
                        return;

                String temp = "ALTER TABLE %s DROP CONSTRAINT %s;";
                var dropSql = fmt(temp, dialect.quote(table), dialect.quote(constraintId));

                execute(session, dropSql);
        }

        @Override
        public void addPrimaryKey(Session session, String table, Collection<Column> primaryKeys)
        {
                StringBuilder builder = new StringBuilder();

                builder.append(fmt("ALTER TABLE %s ADD CONSTRAINT PRIMARY KEY (", dialect.quote(table)));

                for (Column pk : primaryKeys)
                        builder.append(dialect.quote(pk.getName())).append(",");

                builder.delete(builder.length() - 1, builder.length());
                builder.append(");");

                execute(session, builder);
        }

        @Override
        public void alterIndexKeys(Session session, String table, Collection<Index> indexes)
        {
                StringBuilder createIndexBuilder = new StringBuilder();

                for (Index index : indexes) {
                        DMIndexType type = DMIndexType.of(index.getType());
                        switch (type) {
                                case NORMAL -> {
                                        createIndexBuilder.append(fmt("CREATE INDEX %s ON %s.%s(%s);",
                                                dialect.quote(index.getName()),
                                                dialect.quote(session.schema()),
                                                dialect.quote(table),
                                                index.getColumnsText()));
                                }

                                case UNIQUE -> {
                                        createIndexBuilder.append(fmt("CREATE UNIQUE INDEX %s ON %s.%s(%s);",
                                                dialect.quote(index.getName()),
                                                dialect.quote(session.schema()),
                                                dialect.quote(table),
                                                index.getColumnsText()));
                                }

                                case BITMAP -> {
                                        createIndexBuilder.append(fmt("CREATE BITMAP INDEX %s ON %s.%s(%s);",
                                                dialect.quote(index.getName()),
                                                dialect.quote(session.schema()),
                                                dialect.quote(table),
                                                index.getColumnsText()));
                                }
                        }

                }

                execute(session, new SQL(createIndexBuilder));
        }

        @Override
        public void alterChange(Session session, String table, Collection<Column> columns)
        {
                List<String> sqls = Lists.newArrayList();

                // DM 和 MySQL 列名修改是不同的语句，MySQL 支持一条语句同时修改
                // 列的信息和列名称。但 DM 不行，所以需要便利两次字段信息来分别不
                // 同执行列名的修改和列结构的修改
                for (Column column : columns) {
                        if (column.getOriginalName() != null) {
                                if (strne(column.getOriginalName(), column.getName())) {
                                        sqls.add(fmt("ALTER TABLE %s RENAME COLUMN %s TO %s;",
                                                dialect.quote(table),
                                                dialect.quote(column.getOriginalName()),
                                                dialect.quote(column.getName())
                                        ));
                                }
                        }
                }

                // 删除自增
                Captor.icall(() ->
                        execute(session, "ALTER TABLE %s DROP IDENTITY;", dialect.quote(table))
                );

                // 设置自增
                for (Column column : columns) {
                        if (column.isAutoIncrement()) {
                                var sqlfmt = "ALTER TABLE %s ADD COLUMN %s IDENTITY(1, 1);";
                                execute(session, sqlfmt, dialect.quote(table), dialect.quote(column.getName()));
                        }
                }

                // 配置列信息
                for (Column column : columns) {
                        // 达梦不允许修改自增列
                        if (column.isAutoIncrement())
                                continue;

                        // MODIFY
                        StringBuilder modifyOrAddBuilder = new StringBuilder();

                        modifyOrAddBuilder.append(fmt("ALTER TABLE %s %s %s ",
                                dialect.quote(table),
                                column.getOriginalName() != null ? "MODIFY" : "ADD",
                                dialect.quote(column.getName())
                        ));

                        modifyOrAddBuilder.append(column.getType());

                        modifyOrAddBuilder.append(column.isNotNull() ? " NOT NULL" : " NULL");

                        if (strnempty(column.getDefaultValue()))
                                modifyOrAddBuilder.append(" DEFAULT ").append(column.getDefaultValue());

                        modifyOrAddBuilder.append(";");

                        sqls.add(atos(modifyOrAddBuilder));

                        // COMMENT
                        var comment = column.getComment();
                        sqls.add(fmt("COMMENT ON COLUMN %s.%s IS '%s';",
                                dialect.quote(table),
                                dialect.quote(column.getName()),
                                strempty(comment) ? "" : comment));
                }

                /* 批量执行 */
                try (Connection connection = getConnection(session);
                     Statement statement = connection.createStatement()) {
                        if (sqls.isEmpty())
                                return;

                        for (String sql : sqls)
                                statement.addBatch(sql);

                        statement.executeBatch();
                } catch (SQLException e) {
                        throw new DriverException(e);
                }
        }

        @Override
        public void alterVisible(Session session, String table, Collection<Index> indexes)
        {
                for (Index index : indexes) {
                        execute(session, "ALTER INDEX %s %s;",
                                dialect.quote(index.getName()),
                                index.isVisible() ? "VISIBLE" : "INVISIBLE");
                }
        }
}
