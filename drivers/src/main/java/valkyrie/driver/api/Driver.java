package valkyrie.driver.api;

import lombok.Getter;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.node.DBNode;
import valkyrie.driver.api.node.DBNodePath;
import valkyrie.driver.api.sql.SQL;
import valkyrie.driver.api.sql.SQLExecutor;
import valkyrie.driver.api.sql.SQLParsedStatement;
import valkyrie.driver.suggestion.Suggestion;
import valkyrie.driver.utils.ResultSets;
import valkyrie.driver.utils.SQLParser;
import valkyrie.utils.Captor;
import valkyrie.utils.Optional;
import valkyrie.utils.collection.Lists;

import javax.sql.DataSource;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

import static valkyrie.utils.string.StrStaticImports.fmt;

/**
 * JDBC 驱动抽象层。
 * <p>
 * 封装不同数据库的驱动能力入口，提供统一的访问方式。该类不负责连接管理、不负责 SQL 解析，
 * 仅作为能力适配与分发入口，将底层 {@link DataSource} 与上层回调逻辑解耦。
 * <p>
 * <b>职责范围：</b>
 * <ul>
 *   <li>作为数据库能力入口（SQL 执行 / 元数据 / DDL 操作）</li>
 *   <li>绑定数据源以获取底层连接</li>
 *   <li>为不同数据库实现提供统一抽象基类（可通过继承或组合扩展）</li>
 * </ul>
 * <b>职责边界：</b>
 * <ul>
 *   <li>不负责连接池管理（由 {@link DataSource} 负责）</li>
 *   <li>不负责 SQL 解析与语义分析（由上层模块负责）</li>
 *   <li>不直接暴露具体数据库实现细节</li>
 * </ul>
 * <b>扩展方式：</b>
 * <ul>
 *   <li>MySQL / Oracle / PostgreSQL 等可通过继承 {@code Driver} 并重写相关方法实现</li>
 *   <li>或通过组合方式提供具体能力模块</li>
 * </ul>
 *
 * @see DataSource
 * @see Statement
 * @see ResultSet
 *
 * @author Luo Tiansheng
 * @since 2026/4/11
 *
 */
@SuppressWarnings({"SpellCheckingInspection", "SqlSourceToSinkFlow"})
public abstract class Driver implements SQLExecutor
{
        /**
         * 底层数据源，用于获取数据库连接。
         * <p>
         * 该引用为 {@code protected}，允许子类直接访问以支持更灵活的连接管理。
         */
        protected @Getter VkDataSource dataSource;

        /**
         * 执行任务列表
         */
        protected final Map<Long, Statement> taskQueue = new ConcurrentHashMap<>();

        /**
         * Hook 接口
         */
        protected final List<SQLExecuteHook> hooks = new ArrayList<>();

        /**
         * 数据库产品元数据
         */
        protected @Getter ProductMetaData productMetaData;

        /**
         * 数据库方言转换器
         */
        protected final @Getter Dialect dialect;

        /**
         * 构造一个新的驱动实例。
         *
         * @param dataSource 数据源，用于获取数据库连接（不能为 {@code null}）
         * @throws NullPointerException 如果 {@code dataSource} 为 {@code null}
         */
        public Driver(VkDataSource dataSource)
        {
                this.dataSource = Objects.requireNonNull(dataSource, "DataSource must not be null");

                if (dataSource instanceof PooledDataSource) {
                        try (var conn = dataSource.getConnection()) {
                                DatabaseMetaData db = conn.getMetaData();
                                productMetaData = new ProductMetaData();
                                productMetaData.setProductName(Optional.ifError(db::getDatabaseProductName, "ERROR"));
                                productMetaData.setVersion(Optional.ifError(db::getDatabaseProductVersion, "ERROR"));
                                productMetaData.setMajorVersion(Optional.ifError(db::getDatabaseMajorVersion, -1));
                                productMetaData.setMinorVersion(Optional.ifError(db::getDatabaseMinorVersion, -1));
                        } catch (Exception e) {
                                throw new DriverException(e);
                        }
                }

                this.dialect = createDialect();
        }

        /**
         * 注册 Hook 接口
         */
        public void registerExecuteHook(SQLExecuteHook hook)
        {
                hooks.add(hook);
        }

        /**
         * 返回当前驱动实现的数据库类型。
         * <p>
         * 该类型用于标识底层数据库产品（如 MySQL、PostgreSQL、Oracle 等），
         * 以便上层模块根据不同的数据库类型执行特定的逻辑分支或优化策略。
         *
         * @return 当前驱动对应的数据库类型枚举值（永不返回 {@code null}）
         * @see DbType
         */
        public abstract DbType getType();

        /**
         * 获取数据库对象的节点层次结构。
         * <p>
         * 返回当前数据库连接下所有可见对象的树形结构，例如：
         * 数据库（Catalog） → 模式（Schema） → 表（Table）/视图（View）/函数等。
         * 不同数据库的层级结构可能存在差异（如 MySQL 中 Catalog 等同于 Database，
         * 而 Oracle 或 PostgreSQL 中 Catalog 与 Schema 关系不同），具体实现应
         * 遵循目标数据库的实际组织方式。
         *
         * @return 节点列表，表示根节点下的直接子节点；若无可展示对象则返回空列表（永不返回 {@code null}）
         * @see DBNode
         */
        public abstract List<DBNode> getNodeHierarchy();

        /**
         * 获取当前数据库对象节点的层级路径。
         * <p>
         * 返回从根节点到当前选中或活动对象（如当前 Catalog / Schema）的路径信息，
         * 用于定位当前上下文在 {@link #getNodeHierarchy()} 返回的树形结构中的位置。
         * 路径通常由一系列节点标识符组成，例如 {@code ["catalog_name", "schema_name"]}。
         *
         * @return 当前节点的层级路径（若无当前上下文或未选中任何节点，可能返回空路径或 {@code null}，
         *         具体由实现决定）
         * @see DBNodePath
         */
        public abstract DBNodePath getNodeHierarchyPath();

        /**
         * 创建并返回当前环境适用的数据库方言实例。
         * <p>
         * 该方法是一个模板方法（Template Method），由子类实现以提供具体的方言对象。
         * 方言实例封装了特定数据库的 SQL 语法差异，用于生成分页语句、DDL 适配、
         * 标识符转义等数据库特定操作。
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>子类必须实现该方法，返回与目标数据库匹配的 {@link Dialect} 实例</li>
         *   <li>返回的方言实例应为无状态（stateless）且线程安全的，可被多个并发线程共享</li>
         *   <li>通常采用单例模式返回同一个方言实例，避免重复创建开销</li>
         *   <li>实现可根据数据源 URL、数据库产品名称或配置参数动态选择具体方言子类</li>
         * </ul>
         *
         * @return 适用于当前数据库的方言实例（永不返回 {@code null}）
         * @throws IllegalStateException    如果无法根据当前环境确定合适的方言（如数据库类型未知）
         * @throws UnsupportedOperationException 如果当前数据库不被支持
         * @see Dialect
         */
        protected abstract Dialect createDialect();

        /**
         * 获取数据库连接。
         * <p>
         * 调用无参版本等效于 {@link #getConnection(Session) getConnection(null)}，
         * 即不设置任何会话级别的 catalog 或 schema。
         *
         * @return 从底层 {@link DataSource} 获取的数据库连接
         * @throws SQLException 如果数据源无法返回连接或发生数据库访问错误
         * @see #getConnection(Session)
         */
        public Connection getConnection() throws SQLException {
                return getConnection(null);
        }

        /**
         * 获取数据库连接，并可选择性地设置当前会话的 catalog 和 schema。
         * <p>
         * 该方法首先通过底层 {@link DataSource} 获取连接。如果传入的 {@code session} 参数非空，
         * 且其 {@code catalog()} 或 {@code schema()} 返回值不为 {@code null}，则分别调用
         * {@link Connection#setCatalog(String)} 和 {@link Connection#setSchema(String)} 进行设置。
         * <p>
         * <b>注意：</b> 调用方有责任在使用完毕后关闭返回的 {@link Connection} 实例，
         * 推荐使用 try-with-resources 语句以确保资源释放。
         *
         * @param session 会话上下文，包含可选的 catalog 和 schema 信息；可为 {@code null}
         * @return 配置好会话属性的数据库连接
         * @throws SQLException 如果数据源无法返回连接、设置 catalog/schema 失败，
         *                      或发生其他数据库访问错误
         * @see Connection#setCatalog(String)
         * @see Connection#setSchema(String)
         */
        public Connection getConnection(Session session) throws SQLException {
                Connection connection = new ConnectionProxy(dataSource.getConnection(), hooks);

                if (session != null) {
                        if (session.catalog() != null)
                                connection.setCatalog(session.catalog());

                        if (session.schema() != null)
                                connection.setSchema(session.schema());
                }

                return connection;
        }

        /**
         * 生成用于查看指定表的创建语句的 SQL。
         * <p>
         * 不同数据库获取表定义 DDL 的语法差异较大，该方法应返回针对当前方言适配后的可执行 SQL。
         * <p>
         * <b>常见数据库实现示例：</b>
         * <ul>
         *   <li>MySQL: {@code SHOW CREATE TABLE table_name}</li>
         *   <li>PostgreSQL: {@code SELECT pg_get_tabledef('schema.table_name')} 或使用 {@code pg_dump} 相关函数</li>
         *   <li>Oracle: {@code SELECT DBMS_METADATA.GET_DDL('TABLE', 'table_name') FROM DUAL}</li>
         *   <li>SQL Server: {@code sp_helptext 'table_name'} 或查询系统视图</li>
         * </ul>
         *
         * @param session 会话上下文，包含 catalog 和 schema 信息以定位表（不能为 {@code null}）
         * @param table   表名称（不能为 {@code null} 或空白字符串）
         * @return 可执行的 SQL 语句字符串，执行后可获取表的完整创建 DDL
         * @throws NullPointerException     如果 {@code session} 或 {@code table} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code table} 为空白字符串
         * @throws UnsupportedOperationException 如果底层数据库不支持获取表的创建语句
         */
        public abstract String showCreateTable(Session session, String table);

        /**
         * 获取当前数据库实例中所有可用的 catalog（目录）名称列表。
         * <p>
         * 该方法通过 {@link DatabaseMetaData#getCatalogs()} 获取结果集，
         * 并提取列名为 {@code "TABLE_CAT"} 的值。所有 {@link SQLException}
         * 会被捕获并包装为 {@link DriverException} 后重新抛出。
         *
         * @return 不可变的 catalog 名称列表（可能为空，但不为 {@code null}）
         * @throws DriverException 如果数据库元数据访问失败
         * @see DatabaseMetaData#getCatalogs()
         */
        public List<String> getCatalogs() {
                List<String> catalogs = Lists.newArrayList();

                try (Connection connection = getConnection()) {
                        DatabaseMetaData metadata = connection.getMetaData();
                        ResultSet rs = metadata.getCatalogs();

                        while (rs.next())
                                catalogs.add(rs.getString("TABLE_CAT"));

                        return catalogs;
                } catch (SQLException e) {
                        throw new DriverException(e);
                }
        }

        /**
         * 获取当前数据库实例中所有可用的 schema（模式）名称列表。
         * <p>
         * 该方法通过 {@link DatabaseMetaData#getSchemas()} 获取结果集，
         * 并提取列名为 {@code "TABLE_SCHEM"} 的值。所有 {@link SQLException}
         * 会被捕获并包装为 {@link DriverException} 后重新抛出。
         *
         * @return 不可变的 schema 名称列表（可能为空，但不为 {@code null}）
         * @throws DriverException 如果数据库元数据访问失败
         * @see DatabaseMetaData#getSchemas()
         */
        public List<String> getSchemas(Session session) {
                List<String> schemas = Lists.newArrayList();

                try (Connection connection = getConnection(session)) {
                        DatabaseMetaData metadata = connection.getMetaData();
                        ResultSet rs = metadata.getSchemas();

                        while (rs.next())
                                schemas.add(rs.getString("TABLE_SCHEM"));

                        return schemas;
                } catch (SQLException e) {
                        throw new DriverException(e);
                }
        }

        public List<String> getSchemas()
        {
                return getSchemas(null);
        }

        /**
         * 获取当前数据库方言定义的所有保留关键字（Reserved Keywords）列表。
         * <p>
         * 返回的关键字通常包括 SQL 标准保留字以及数据库特有的扩展关键字。这些关键字在
         * 作为标识符（表名、列名等）使用时需要被正确转义，以避免语法错误。
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>返回的列表应为不可变副本或不可修改视图，防止调用方意外修改</li>
         *   <li>关键字应使用大写形式，与数据库系统内部表示保持一致</li>
         *   <li>建议从数据库元数据或内置常量中获取，确保与实际数据库版本匹配</li>
         * </ul>
         *
         * @return 保留关键字列表（永不返回 {@code null}，若无关键字则返回空列表）
         */
        public abstract List<Suggestion> getSuggestions(Session session);

        /**
         * 获取指定会话上下文中所有用户定义的表名称列表。
         * <p>
         * 该方法调用 {@link DatabaseMetaData#getTables(String, String, String, String[])}，
         * 参数使用：catalog 和 schema 取自 {@code session}，表名模式为 {@code "%"}（匹配所有），
         * 类型数组限定为 {@code "TABLE"}（仅返回基本表，不包括视图、系统表等）。
         * <p>
         * 注意：如果 {@code session.catalog()} 或 {@code session.schema()} 返回 {@code null}，
         * 则对应的参数将按照 JDBC 规范解释（通常表示不限制该层级）。
         * <p>
         * 由于不同的数据库表结构的规范是不相同的，所以需要子类自己实现数据库表结构的查询和生成，
         * 避免 JDBC 标准查出来数据信息过少。
         *
         * @param session 会话上下文，包含 catalog 和 schema 过滤条件（不能为 {@code null}）
         * @return 表名列表（可能为空，但不为 {@code null}）
         * @throws NullPointerException 如果 {@code session} 为 {@code null}
         * @throws DriverException 如果数据库元数据访问失败
         * @see DatabaseMetaData#getTables(String, String, String, String[])
         */
        public abstract List<Table> getTables(Session session);

        /**
         * 获取指定数据库表的列元信息列表。
         * <p>
         * 根据当前方言的实现，从数据库元数据中提取指定表的所有列的详细信息，
         * 包括列名、数据类型、是否可空、是否主键、默认值、注释等。
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>返回的列表顺序应与表定义中的列顺序一致（通常按 {@code ORDINAL_POSITION} 升序）</li>
         *   <li>应通过 {@link java.sql.DatabaseMetaData#getColumns(String, String, String, String)} 获取原始元数据</li>
         *   <li>对于不支持 catalog 或 schema 的数据库，对应的 {@code session} 参数中的属性可为 {@code null}</li>
         * </ul>
         * <p>
         * <b>使用示例：</b>
         * <pre>{@code
         * Session session = new Session("my_db", "public");
         * List<Column> columns = dialect.getColumns(session, "user_table");
         * for (Column col : columns) {
         *     System.out.println(col.name() + " : " + col.type());
         * }
         * }</pre>
         *
         * @param session 会话上下文，包含 catalog 和 schema 信息以定位表（不能为 {@code null}）
         * @param table   表名称（不能为 {@code null} 或空白字符串）
         * @return 包含表所有列元数据的不可变列表（若表不存在或无权限，返回空列表）
         * @throws NullPointerException     如果 {@code session} 或 {@code table} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code table} 为空白字符串
         * @throws DriverException   如果底层 JDBC 访问发生错误（包装 {@link java.sql.SQLException}）
         * @see java.sql.DatabaseMetaData#getColumns(String, String, String, String)
         * @see Column
         */
        public List<Column> getColumns(Session session, String table)
        {
                try {
                        List<Column> columns = selectByPage(session, table, 0, 0).getColumns();

                        Map<String, Column> columnMap = new HashMap<>();

                        for (Column column : columns) {
                                column.setOriginalName(column.getName());
                                columnMap.put(column.getName(), column);
                        }

                        String createTableDDL = dialect.normalize(showCreateTable(session, table));

                        SQLParser.parseColumnDefSpec(createTableDDL, dialect, columnMap);

                        /* 防篡改码生成 */
                        columns.forEach(Column::finalIntegrityCode);

                        return columns;
                } catch (Exception e) {
                        throw new DriverException(e);
                }
        }

        public List<Column> getColumns(Session session, Table table)
        {
                return getColumns(session, table.getName());
        }

        /**
         * 获取当前会话下所有表的列信息。
         * <p>
         * 供 SQL 智能提示按表做上下文过滤使用，默认通过 JDBC
         * {@link DatabaseMetaData#getColumns(String, String, String, String)} 一次性读取，
         * 不支持元数据的驱动可覆写返回空集合。
         *
         * @param session 会话上下文
         * @return 表名（保留数据库原始大小写）到列集合的映射
         */
        public Map<String, List<Column>> getTableColumns(Session session)
        {
                Map<String, List<Column>> result = new HashMap<>();

                try (Connection connection = getConnection(session)) {
                        DatabaseMetaData meta = connection.getMetaData();

                        try (ResultSet rs = meta.getColumns(
                                connection.getCatalog(), connection.getSchema(), "%", "%")) {
                                while (rs.next()) {
                                        Column column = new Column();
                                        column.setName(rs.getString("COLUMN_NAME"));
                                        column.setType(rs.getString("TYPE_NAME"));
                                        column.setComment(rs.getString("REMARKS"));

                                        result.computeIfAbsent(rs.getString("TABLE_NAME"),
                                                k -> new ArrayList<>()).add(column);
                                }
                        }
                } catch (Exception e) {
                        throw new DriverException(e);
                }

                return result;
        }

        /**
         * 获取指定数据库表的所有索引信息。
         * <p>
         * 该方法通过 {@link java.sql.DatabaseMetaData#getIndexInfo(String, String, String, boolean, boolean)}
         * 获取目标表上定义的所有索引（包括主键索引、唯一索引、普通索引等），并将每个索引封装为 {@link Index} 对象。
         * <p>
         * <b>返回的索引信息包含：</b>
         * <ul>
         *   <li>索引名称（{@link Index#getName()} ()}）</li>
         *   <li>索引类型（唯一索引、普通索引、全文索引等）</li>
         *   <li>索引的排序方向（ASC/DESC）</li>
         *   <li>索引的过滤条件（部分索引，如 PostgreSQL 的 WHERE 子句）</li>
         * </ul>
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>应按照索引名称和列在索引中的位置（ORDINAL_POSITION）进行排序返回</li>
         *   <li>主键索引可能被某些数据库视为特殊的索引（如 MySQL 中主键约束对应 {@code PRIMARY} 索引），应一并返回</li>
         *   <li>应过滤掉系统生成的内部索引（如外键自动创建的索引），避免信息冗余</li>
         *   <li>若表不存在或无任何索引，返回空列表（而非 {@code null}）</li>
         *   <li>需要处理不同数据库对索引元数据返回的差异（如 Oracle 的索引与约束关系）</li>
         * </ul>
         *
         * @param session 会话上下文，包含 catalog 和 schema 信息以定位表（不能为 {@code null}）
         * @param table   目标表元数据（包含表名及所在 catalog/schema，不能为 {@code null}）
         * @return 包含表所有索引信息的列表，按索引名称及列顺序排列；若无索引则返回空列表（永不为 {@code null}）
         * @throws NullPointerException      如果 {@code session} 或 {@code table} 为 {@code null}
         * @throws DriverException    如果获取元数据过程中发生 {@link java.sql.SQLException}
         * @see java.sql.DatabaseMetaData#getIndexInfo(String, String, String, boolean, boolean)
         * @see Index
         */
        public abstract List<Index> getIndexes(Session session, String table);

        public List<Index> getIndexes(Session session, Table table) {
                return getIndexes(session, table.getName());
        }

        /**
         * 获取当前数据库方言支持的所有索引类型名称。
         * <p>
         * 不同数据库支持不同的索引类型，该方法返回的类型名称应与数据库内部定义的索引类型关键字一致。
         * <p>
         * <b>常见索引类型示例：</b>
         * <ul>
         *   <li>MySQL: {@code BTREE}, {@code HASH}, {@code FULLTEXT}, {@code SPATIAL}</li>
         *   <li>PostgreSQL: {@code BTREE}, {@code HASH}, {@code GIST}, {@code GIN}, {@code BRIN}, {@code SPGIST}</li>
         *   <li>Oracle: {@code NORMAL} (B-Tree), {@code BITMAP}, {@code FUNCTION-BASED}, {@code DOMAIN}</li>
         *   <li>SQL Server: {@code CLUSTERED}, {@code NONCLUSTERED}, {@code COLUMNSTORE}, {@code XML}</li>
         * </ul>
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>返回的集合应为不可变集合（如 {@link java.util.Collections#unmodifiableSet}）或副本，避免调用方修改</li>
         *   <li>集合中不应包含重复元素</li>
         *   <li>若数据库支持动态扩展索引类型（如通过插件），实现类应能动态获取或至少返回内置支持的类型</li>
         *   <li>类型名称应使用大写形式，与数据库系统表或 {@code CREATE INDEX} 语法中的关键字保持一致</li>
         * </ul>
         * <p>
         * <b>使用示例：</b>
         * <pre>{@code
         * Set<String> types = dialect.getIndexTypes();
         * if (types.contains("BTREE")) {
         *     // 可以创建 B-Tree 索引
         * }
         * }</pre>
         *
         * @return 包含所有支持的索引类型名称的不可变集合（永不为 {@code null}，可能为空集合表示不支持显式指定索引类型）
         */
        public abstract Set<String> getIndexTypes();

        /**
         * 删除指定的数据库表。
         * <p>
         * 执行 DDL 操作移除整个表及其所有数据、索引、约束等。不同数据库的删除语法基本一致
         * （{@code DROP TABLE table_name}），但可能需要处理 {@code IF EXISTS} 子句或级联选项。
         * <p>
         * <b>实现注意事项：</b>
         * <ul>
         *   <li>应考虑数据库是否支持 {@code IF EXISTS} 子句以避免表不存在时抛出异常</li>
         *   <li>可能需要处理 {@code CASCADE} 选项以删除依赖该表的视图、外键等（如 PostgreSQL）</li>
         *   <li>该操作不可逆，实现时应注意事务语义（通常 DDL 在大多数数据库中隐式提交）</li>
         * </ul>
         *
         * @param session 当前会话上下文，包含 catalog 和 schema 信息
         * @param table 要删除的表名（不能为 {@code null} 或空白字符串）
         * @throws NullPointerException     如果 {@code table} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code table} 为空白字符串
         * @throws DriverException   如果执行 DDL 失败（包装 {@link java.sql.SQLException}）
         */
        public abstract void dropTable(Session session, String table);

        public void dropTable(Session session, Table table) {
                dropTable(session, table.getName());
        }

        /**
         * 删除指定表中的多个列。
         * <p>
         * 执行 DDL 操作从表中移除一个或多个列。不同数据库对删除列的支持差异较大：
         * <ul>
         *   <li>MySQL: {@code ALTER TABLE table_name DROP COLUMN col1, DROP COLUMN col2}</li>
         *   <li>PostgreSQL: 支持在单个 {@code ALTER TABLE} 中多次使用 {@code DROP COLUMN}</li>
         *   <li>Oracle: 每个 {@code DROP COLUMN} 需要单独的 {@code ALTER TABLE} 语句或使用 {@code SET UNUSED}</li>
         * </ul>
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>应尽量在单条 DDL 语句中完成所有列的删除（若数据库支持）以提高性能</li>
         *   <li>需处理列不存在的情况（根据方言策略选择忽略或抛出异常）</li>
         *   <li>注意删除列可能导致的依赖对象失效（如索引、约束），可考虑 {@code CASCADE} 选项</li>
         * </ul>
         *
         * @param session 当前会话上下文，包含 catalog 和 schema 信息
         * @param table   目标表元数据（包含表名及所在 catalog/schema，不能为 {@code null}）
         * @param columns 要删除的列集合（不能为 {@code null} 或空集合）
         * @throws NullPointerException     如果 {@code table} 或 {@code columns} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code columns} 为空集合，或任一列未绑定到该表
         * @throws DriverException   如果执行 DDL 失败
         */
        public abstract void dropColumns(Session session, String table, Collection<Column> columns);

        public void dropColumns(Session session, Table table, Collection<Column> columns) {
                dropColumns(session, table.getName(), columns);
        }

        /**
         * 删除指定表上的多个索引。
         * <p>
         * 执行 DDL 操作移除一个或多个索引。不同数据库对删除索引的语法和支持程度存在差异：
         * <ul>
         *   <li>MySQL: {@code DROP INDEX index_name ON table_name}，支持在单条语句中删除多个索引（需重复子句）</li>
         *   <li>PostgreSQL: {@code DROP INDEX index_name1, index_name2}（需指定索引名，无需表名，因为索引在数据库中全局或 schema 内唯一）</li>
         *   <li>Oracle: {@code DROP INDEX index_name}（索引独立于表，需指定索引名）</li>
         *   <li>SQL Server: {@code DROP INDEX table_name.index_name} 或 {@code DROP INDEX index_name ON table_name}</li>
         * </ul>
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>需要根据数据库方言选择正确的语法格式（表名前缀、是否支持多索引删除）</li>
         *   <li>若某个索引不存在，实现应根据策略选择忽略或抛出异常（建议提供配置选项）</li>
         * </ul>
         *
         * @param session 当前会话上下文，包含 catalog 和 schema 信息
         * @param table 目标表元数据（包含表名及所在 catalog/schema，不能为 {@code null}）
         * @param selectionItems 要删除的索引集合（每个 {@link Index} 应至少包含索引名称，不能为 {@code null} 或空集合）
         * @throws NullPointerException 如果 {@code table} 或 {@code selectionItems} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code selectionItems} 为空集合，或任一索引缺少必要的名称信息
         * @throws UnsupportedOperationException 如果数据库方言不支持删除索引操作
         * @throws DriverException 如果执行 DDL 失败（包装 {@link java.sql.SQLException}）
         * @see Index
         */
        public abstract void dropIndexKeys(Session session, String table, Collection<Index> selectionItems);

        public void dropIndexKeys(Session session, Table table, Collection<Index> selectionItems) {
                dropIndexKeys(session, table.getName(), selectionItems);
        }

        /**
         * 删除指定表的主键约束。
         * <p>
         * 该方法直接移除表的主键约束，不进行主键列匹配校验。
         * 若表当前不存在主键约束，实现应静默忽略，不抛出异常。
         *
         * @param session 会话上下文（不能为 {@code null}）
         * @param table 目标表名称（不能为 {@code null} 或空白字符串）
         * @throws NullPointerException 如果 {@code session} 或 {@code table} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code table} 为空白字符串
         * @throws UnsupportedOperationException 如果数据库方言不支持删除主键约束
         */
        public abstract void dropPrimaryKey(Session session, String table);

        public void dropPrimaryKey(Session session, Table table) {
                dropPrimaryKey(session, table.getName());
        }

        /**
         * 更新指定表的主键约束。
         * <p>
         * 该方法用于替换表的现有主键为新定义的主键列集合。内部实现为先删除当前主键约束，
         * 再添加新的主键约束。
         * <p>
         * <b>删除阶段异常处理：</b>
         * <ul>
         *   <li>若删除主键时因主键不存在而失败（如当前表无主键约束），该异常将被静默忽略，
         *       继续执行添加新主键的操作</li>
         *   <li>若删除阶段发生其他类型的异常（如数据库连接问题、权限不足等），则直接抛出，
         *       不会继续执行添加主键操作</li>
         * </ul>
         * <p>
         * <b>参数 {@code primaryKeys} 说明：</b>
         * <ul>
         *   <li>若 {@code primaryKeys} 为 {@code null} 或空集合，则表示仅删除现有主键，
         *       不添加新的主键约束</li>
         *   <li>若非空，则按集合顺序创建复合主键（集合顺序决定复合主键中各列的顺序）</li>
         * </ul>
         *
         * @param session 会话上下文（不能为 {@code null}）
         * @param table 目标表名称（不能为 {@code null} 或空白字符串）
         * @param primaryKeys 新主键列集合
         * @throws NullPointerException 如果 {@code session} 或 {@code table} 为 {@code null}
         * @throws IllegalArgumentException 如果 {@code table} 为空白字符串，或任一列不存在于表中，
         *                                  或列数量为 0 但数据库不允许无主键表
         * @throws UnsupportedOperationException 如果数据库方言不支持添加主键约束
         * @throws DriverException 如果删除阶段发生非“主键不存在”的异常，或添加主键阶段发生异常
         */
        public abstract void addPrimaryKey(Session session, String table, Collection<Column> primaryKeys);

        public void addPrimaryKey(Session session, Table table, Collection<Column> primaryKeys) {
                addPrimaryKey(session, table.getName(), primaryKeys);
        }

        /**
         * 修改指定表上的多个索引定义（如索引列、索引类型等）。
         * <p>
         * 该方法用于变更一个或多个索引的结构，典型场景包括：
         * <ul>
         *   <li>为现有索引添加或删除列（改变索引键）</li>
         *   <li>修改索引类型（如从 B-Tree 改为 Hash）</li>
         *   <li>调整索引的排序方向（ASC/DESC）</li>
         *   <li>更改索引的存储参数或并发选项</li>
         * </ul>
         * <p>
         * <b>实现注意事项：</b>
         * <ul>
         *   <li>大多数数据库不直接支持“修改索引”操作，通常的实现方式是：
         *       <ol>
         *         <li>根据 {@link Index} 对象中的新定义生成创建索引的 DDL</li>
         *         <li>删除旧索引（如果名称相同但定义不同）</li>
         *         <li>创建新索引</li>
         *       </ol>
         *   </li>
         *   <li>应考虑操作的原子性：如果可能，将操作包装在事务中；否则需提供回滚或错误恢复建议</li>
         *   <li>对于生产环境，建议使用 {@code CONCURRENTLY} 等选项避免锁表（如 PostgreSQL 支持）</li>
         *   <li>若索引不存在或新定义与现有定义相同，应忽略或根据策略抛出异常</li>
         *   <li>应优先使用数据库原生的 {@code ALTER INDEX} 语法（如 Oracle 的 {@code ALTER INDEX ... REBUILD}，
         *       但该语法通常不修改索引键，仅重建）—— 实际修改键时仍需删除重建</li>
         * </ul>
         * <p>
         * <b>参数 {@code indexes} 说明：</b>
         * <ul>
         *   <li>每个 {@link Index} 对象应包含索引名称以及完整的索引新定义（包含列名、索引类型等）</li>
         *   <li>若某个 {@code Index} 对象中的索引名称在表上不存在，实现应抛出 {@link IllegalArgumentException}</li>
         *   <li>若 {@code Index} 中的定义与其当前定义相同，可跳过该索引的修改</li>
         * </ul>
         * <p>
         * <b>使用示例：</b>
         * <pre>{@code
         * Session session = new Session("my_db", "public");
         * Table userTable = ...;
         * Index newIndexDef = Index.builder()
         *         .name("idx_username")
         *         .columns(List.of("last_name", "first_name"))  // 修改为复合索引
         *         .type(IndexType.BTREE)
         *         .build();
         * dialect.alterIndexKeys(session, userTable, List.of(newIndexDef));
         * }</pre>
         *
         * @param session 会话上下文，用于获取连接及设置 catalog/schema（不能为 {@code null}）
         * @param table   目标表元数据（包含表名及所在 catalog/schema，不能为 {@code null}）
         * @param indexes 需要修改的索引定义集合（不能为 {@code null} 或空集合），每个元素包含索引名称及新定义
         * @throws NullPointerException              如果 {@code session}、{@code table} 或 {@code indexes} 为 {@code null}
         * @throws IllegalArgumentException          如果 {@code indexes} 为空集合，或任一索引缺少名称，或索引不存在于表上，
         *                                           或新定义与现有定义相同但策略要求不忽略
         * @throws UnsupportedOperationException     如果数据库方言不支持索引修改（包括删除重建的方式）
         * @throws DriverException            如果执行 DDL 失败（包装 {@link java.sql.SQLException}）
         * @see Index
         */
        public abstract void alterIndexKeys(Session session, String table, Collection<Index> indexes);

        public void alterIndexKeys(Session session, Table table, Collection<Index> indexes) {
                alterIndexKeys(session, table.getName(), indexes);
        }

        /**
         * 修改表中多个列的定义（变更列属性）。
         * <p>
         * 该方法用于执行列的“更改”操作，包括修改列的数据类型、默认值、是否可空、注释等，
         * 但不包括删除列或重命名列（重命名应使用专门的 {@code renameColumn} 方法）。
         * <p>
         * <b>典型变更内容：</b>
         * <ul>
         *   <li>修改数据类型：{@code ALTER TABLE t MODIFY col VARCHAR(255)}</li>
         *   <li>修改默认值：{@code ALTER TABLE t ALTER COLUMN col SET DEFAULT 0}</li>
         *   <li>修改可空性：{@code ALTER TABLE t MODIFY col NOT NULL}</li>
         *   <li>修改注释：{@code ALTER TABLE t MODIFY col COMMENT 'new comment'}</li>
         * </ul>
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>应尽量生成单条 DDL 语句完成所有列的修改（若数据库支持）</li>
         *   <li>不同数据库的语法差异很大（MySQL 的 {@code MODIFY}，PostgreSQL 的 {@code ALTER COLUMN}，
         *       Oracle 的 {@code MODIFY} 等），实现类需针对目标数据库适配</li>
         *   <li>仅修改 {@link Column} 对象中实际发生变化的属性，避免不必要的变更</li>
         *   <li>对于不支持某些修改操作的数据库，应抛出 {@code UnsupportedOperationException}</li>
         * </ul>
         *
         * @param session 当前会话上下文，包含 catalog 和 schema 信息
         * @param table   目标表名称（不能为 {@code null} 或空白字符串）
         * @param columns 需要变更的列集合，每个 {@link Column} 应包含完整的新定义（不能为 {@code null} 或空集合）
         * @throws NullPointerException             如果 {@code table} 或 {@code columns} 为 {@code null}
         * @throws IllegalArgumentException         如果 {@code columns} 为空集合，或任一列未包含必要的标识信息（如列名）
         * @throws UnsupportedOperationException    如果数据库方言不支持列修改操作
         * @throws DriverException           如果执行 DDL 失败
         */
        public abstract void alterChange(Session session, String table, Collection<Column> columns);

        public void alterChange(Session session, Table table, Collection<Column> columns) {
                alterChange(session, table.getName(), columns);
        }

        /**
         * 修改指定表上多个索引的可见性状态。
         * <p>
         * 该方法用于启用或禁用一个或多个索引，而不删除索引定义。被禁用的索引将不会被查询优化器使用，
         * 但索引定义仍保留在数据库系统表中，可随时重新启用。
         * <p>
         * <b>适用场景：</b>
         * <ul>
         *   <li>临时禁用索引以评估其对查询性能的影响</li>
         *   <li>在大规模数据导入前禁用索引以提高写入性能，导入后重新启用</li>
         *   <li>故障排查时隔离特定索引以定位性能问题</li>
         * </ul>
         * <p>
         * <b>数据库支持差异：</b>
         * <ul>
         *   <li>Oracle: 支持 {@code ALTER INDEX index_name VISIBLE/INVISIBLE}</li>
         *   <li>MySQL 8.0+: 支持 {@code ALTER INDEX index_name VISIBLE/INVISIBLE}</li>
         *   <li>PostgreSQL: 不直接支持索引可见性，需通过 {@code pg_index.indisvisible} 或重新创建索引</li>
         *   <li>SQL Server: 支持 {@code ALTER INDEX index_name ON table_name DISABLE/REBUILD}</li>
         * </ul>
         * <p>
         * <b>实现要求：</b>
         * <ul>
         *   <li>每个 {@link Index} 对象应包含索引名称及目标可见性状态（通过 {@link Index#isVisible()} 或类似方法）</li>
         *   <li>应尽量生成单条 DDL 语句完成所有索引的可见性修改（若数据库支持）</li>
         *   <li>若数据库不支持索引可见性修改，应抛出 {@link UnsupportedOperationException}</li>
         *   <li>若指定索引不存在，应根据策略选择忽略或抛出 {@link IllegalArgumentException}</li>
         *   <li>注意：禁用索引可能导致依赖该索引的约束失效，实现时应考虑级联影响</li>
         *   <li>建议在操作前后记录日志，便于问题追踪</li>
         * </ul>
         *
         * @param session 会话上下文，用于获取连接及设置 catalog/schema（不能为 {@code null}）
         * @param table   目标表名称（不能为 {@code null} 或空白字符串）
         * @param indexes 需要修改可见性的索引集合，每个元素包含索引名称及目标可见性状态（不能为 {@code null} 或空集合）
         * @throws NullPointerException              如果 {@code session}、{@code table} 或 {@code indexes} 为 {@code null}
         * @throws IllegalArgumentException          如果 {@code table} 为空白字符串，或 {@code indexes} 为空集合，
         *                                           或任一索引缺少名称，或指定索引不存在于表上
         * @throws UnsupportedOperationException     如果数据库方言不支持索引可见性修改
         * @throws DriverException            如果执行 DDL 失败（包装 {@link java.sql.SQLException}）
         * @see Index#isVisible()
         */
        public abstract void alterVisible(Session session, String table, Collection<Index> indexes);

        public void alterVisible(Session session, Table table, Collection<Index> indexes) {
                alterVisible(session, table.getName(), indexes);
        }

        /* *********************************************************************************** */
        /*                                SQL EXECUTOR IMPLEMENTS                              */
        /* *********************************************************************************** */

        private static final SQLExecuteCallback DEFAULT_SQL_EXECUTE_CALLBACK = new SQLExecuteCallback() {};

        @Override
        public QueryResult selectByPage(Session session, String table, int off, int size)
        {
                String sql = fmt("SELECT * FROM %s", dialect.quote(table));
                return execute(session, new SQL(dialect.limit(sql, off, size)));
        }

        @Override
        public QueryResult execute(long jobId, Session session, SQL sql)
        {
                return execute(jobId, session, sql, DEFAULT_SQL_EXECUTE_CALLBACK);
        }

        public QueryResult execute(long jobId, Session session, SQL sql, SQLExecuteCallback callback)
        {
                try (Connection connection = getConnection(session)) {
                        try (Statement statement = connection.createStatement()) {
                                QueryResult queryResult = null;
                                taskQueue.put(jobId, statement);
                                SQLParsedStatement lastPS = sql.getLast();

                                for (SQLParsedStatement ps : sql) {
                                        String currentExecuteSQL = ps.toString();

                                        switch (ps.getCommand()) {
                                                case EXECUTE -> {
                                                        callback.execute(currentExecuteSQL);
                                                        long startTime = System.currentTimeMillis();
                                                        statement.execute(currentExecuteSQL);
                                                        long endTime = System.currentTimeMillis();
                                                        callback.cost(endTime - startTime);
                                                }

                                                case EXECUTE_UPDATE -> {
                                                        callback.executeUpdate(currentExecuteSQL);
                                                        long startTime = System.currentTimeMillis();
                                                        int row = statement.executeUpdate(currentExecuteSQL);
                                                        long endTime = System.currentTimeMillis();
                                                        callback.row(row);
                                                        callback.cost(endTime - startTime);
                                                }

                                                case EXECUTE_QUERY -> {
                                                        if (ps == lastPS) {
                                                                callback.executeQuery(currentExecuteSQL, false);
                                                                long startTime = System.currentTimeMillis();
                                                                boolean hasResultSet = statement.execute(currentExecuteSQL);

                                                                /*
                                                                 * 查询类语句统一走 execute()：能返回结果集才构建结果网格；
                                                                 * 不返回结果集（如 SELECT ... INTO 用户变量）也不会抛
                                                                 * "cannot issue statements that do not produce result sets"。
                                                                 */
                                                                if (hasResultSet) {
                                                                        ResultSet rs = statement.getResultSet();
                                                                        queryResult = new QueryResult(session, this, sql);
                                                                        ResultSets.toDataGrid(connection, ps, rs, dialect, queryResult);
                                                                }
                                                                long endTime = System.currentTimeMillis();
                                                                callback.cost(endTime - startTime);
                                                        } else {
                                                                callback.executeQuery(currentExecuteSQL, true);
                                                        }
                                                }
                                        }

                                        if (ps == lastPS && queryResult != null)
                                                return queryResult;
                                }

                                return null;
                        }
                } catch (SQLException e) {
                        throw new DriverException(e);
                }
        }

        @Override
        @SuppressWarnings("ALL")
        public void cancel(long jobId)
        {
                if (taskQueue.containsKey(jobId))
                        Captor.call(() -> taskQueue.remove(jobId).cancel());
        }
}
