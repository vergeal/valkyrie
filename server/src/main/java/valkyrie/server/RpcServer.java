package valkyrie.server;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.github.vertical_blank.sqlformatter.SqlFormatter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import valkyrie.core.model.DiskSavedConnection;
import valkyrie.core.model.QueryFile;
import valkyrie.core.exception.CoreException;
import valkyrie.core.repository.ConnectionRepository;
import valkyrie.core.repository.QueryFileRepository;
import valkyrie.driver.api.Column;
import valkyrie.driver.api.ConnectionConfig;
import valkyrie.driver.api.DbType;
import valkyrie.driver.api.Dialect;
import valkyrie.driver.api.Driver;
import valkyrie.driver.api.DriverFactory;
import valkyrie.driver.api.ForeignKey;
import valkyrie.driver.api.GridRow;
import valkyrie.driver.api.Index;
import valkyrie.driver.api.QueryResult;
import valkyrie.driver.api.SQLExecuteCallback;
import valkyrie.driver.api.Session;
import valkyrie.driver.api.Table;
import valkyrie.driver.api.VkDataSource;
import valkyrie.driver.api.node.DBNode;
import valkyrie.driver.api.node.DBCatalogNode;
import valkyrie.driver.api.node.DBColumnNode;
import valkyrie.driver.api.node.DBForeignKeyNode;
import valkyrie.driver.api.node.DBIndexNode;
import valkyrie.driver.api.node.DBObjectContainerNode;
import valkyrie.driver.api.node.DBObjectNode;
import valkyrie.driver.api.node.DBQueryContainerNode;
import valkyrie.driver.api.node.DBSchemaNode;
import valkyrie.driver.api.node.DBTableContainerNode;
import valkyrie.driver.api.node.DBTableNode;
import valkyrie.driver.api.sql.SQL;
import valkyrie.driver.suggestion.Suggestion;
import valkyrie.driver.suggestion.SuggestionEngine;
import valkyrie.utils.exception.Causes;
import valkyrie.utils.poi.WorkBook;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Set;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 基于标准输入输出的 JSON-RPC 服务。
 * <p>
 * 协议为按行分隔的 JSON：
 * <ul>
 *   <li>请求：{@code {"id":<any>,"method":"<name>","params":{...}}}</li>
 *   <li>响应：{@code {"id":<any>,"result":{...}}} 或 {@code {"id":<any>,"error":{"message":"..."}}}</li>
 *   <li>通知：{@code {"method":"event","params":{"channel":"...",...}}}</li>
 * </ul>
 * 每个请求由独立工作线程处理，因此长时间执行的查询不会阻塞 ping / query.cancel。
 *
 * @author Luo Tiansheng
 * @since 2026/9/12
 */
public class RpcServer
{
        private static final Logger LOG = LoggerFactory.getLogger(RpcServer.class);

        private final PrintStream out;
        private final Object writeLock = new Object();

        private final ExecutorService workers = Executors.newCachedThreadPool(r -> {
                Thread thread = new Thread(r, "rpc-worker");
                thread.setDaemon(true);
                return thread;
        });

        private final Map<String, OpenConnection> sessions = new ConcurrentHashMap<>();
        /* 每个会话（按 catalog/schema 维度）缓存一次智能提示引擎，避免每次按键都读元数据 */
        private final Map<String, SuggestionEngine> suggestionEngines = new ConcurrentHashMap<>();
        /*
         * 补全元数据快照：key = 连接名|catalog|schema。
         * 连接打开期间算好的引擎在这里留一份，断开连接后查询控制台仍能提示表名与字段。
         */
        private final Map<String, SuggestionEngine> suggestionSnapshots = new ConcurrentHashMap<>();
        /* 已执行的结果集缓存：编辑、提交、删除都作用在同一个 QueryResult 上 */
        private final Map<Long, QueryResult> resultCache = new ConcurrentHashMap<>();
        private final Map<Long, String> resultOwner = new ConcurrentHashMap<>();
        private final AtomicLong sessionSequence = new AtomicLong();

        public RpcServer(PrintStream out)
        {
                this.out = out;
        }

        /* ********************************************************************* */
        /*                              协议处理                                  */
        /* ********************************************************************* */

        public void ready()
        {
                JSONObject payload = new JSONObject();
                payload.put("pid", ProcessHandle.current().pid());
                payload.put("javaVersion", System.getProperty("java.version"));

                notify("server.ready", payload);
        }

        public void handle(String line)
        {
                workers.execute(() -> dispatch(line));
        }

        private void dispatch(String line)
        {
                Object id = null;

                try {
                        JSONObject request = JSON.parseObject(line);
                        id = request.get("id");

                        String method = request.getString("method");
                        JSONObject params = request.getJSONObject("params");

                        Object result = call(method, params == null ? new JSONObject() : params);

                        respond(id, result);
                } catch (Throwable e) {
                        LOG.error("RPC 调用失败: {}", line, e);
                        fail(id, e);
                }
        }

        private Object call(String method, JSONObject params)
        {
                return switch (method) {
                        case "ping" -> ping();
                        case "connections.list" -> listConnections();
                        case "connections.save" -> saveConnection(params);
                        case "connections.delete" -> deleteConnection(params);
                        case "connection.open" -> openConnection(params);
                        case "connection.close" -> closeConnection(params);
                        case "schema.children" -> schemaChildren(params);
                        case "schema.roots" -> schemaRoots(params);
                        case "table.page" -> tablePage(params);
                        case "table.columns" -> tableColumns(params);
                        case "table.indexes" -> tableIndexes(params);
                        case "table.ddl" -> tableDdl(params);
                        case "table.design" -> designTable(params);
                        case "table.export" -> exportTableSql(params);
                        case "database.export" -> exportDatabaseSql(params);
                        case "sql.format" -> formatSql(params);
                        case "sql.suggest" -> suggestSql(params);
                        case "sql.warmSuggest" -> warmSuggest(params);
                        case "result.update" -> updateCell(params);
                        case "result.insert" -> insertRow(params);
                        case "result.delete" -> deleteRows(params);
                        case "result.setNull" -> setNull(params);
                        case "result.commit" -> commitResult(params);
                        case "result.rollback" -> rollbackResult(params);
                        case "result.reload" -> reloadResult(params);
                        case "queryFiles.list" -> listQueryFiles(params);
                        case "queryFiles.read" -> readQueryFile(params);
                        case "queryFiles.save" -> saveQueryFile(params);
                        case "queryFiles.rename" -> renameQueryFile(params);
                        case "queryFiles.delete" -> deleteQueryFile(params);
                        case "result.export" -> exportResult(params);
                        case "query.execute" -> executeQuery(params);
                        case "query.cancel" -> cancelQuery(params);
                        default -> throw new IllegalArgumentException("未知方法: " + method);
                };
        }

        private void respond(Object id, Object result)
        {
                JSONObject message = new JSONObject();
                message.put("id", id);
                message.put("result", result == null ? new JSONObject() : result);

                write(message);
        }

        private void fail(Object id, Throwable e)
        {
                JSONObject error = new JSONObject();
                error.put("message", Causes.message(e));
                error.put("type", e.getClass().getName());

                JSONObject message = new JSONObject();
                message.put("id", id);
                message.put("error", error);

                write(message);
        }

        private void notify(String channel, JSONObject payload)
        {
                JSONObject params = new JSONObject();
                params.put("channel", channel);

                if (payload != null)
                        params.putAll(payload);

                JSONObject message = new JSONObject();
                message.put("method", "event");
                message.put("params", params);

                write(message);
        }

        private void write(JSONObject message)
        {
                /* 多线程共用一个输出流，必须串行写入，避免 JSON 行交错 */
                synchronized (writeLock) {
                        out.println(message.toJSONString());
                        out.flush();
                }
        }

        /* ********************************************************************* */
        /*                              连接配置                                  */
        /* ********************************************************************* */

        private Object ping()
        {
                JSONObject ret = new JSONObject();
                ret.put("pong", true);
                ret.put("pid", ProcessHandle.current().pid());
                ret.put("javaVersion", System.getProperty("java.version"));
                return ret;
        }

        private Object listConnections()
        {
                JSONArray connections = new JSONArray();

                for (DiskSavedConnection connection : ConnectionRepository.loadConnections())
                        connections.add(JSON.parseObject(JSON.toJSONString(connection)));

                JSONObject ret = new JSONObject();
                ret.put("connections", connections);
                return ret;
        }

        private Object saveConnection(JSONObject params)
        {
                JSONObject connection = params.getJSONObject("connection");

                if (connection == null || connection.getString("name") == null)
                        throw new IllegalArgumentException("connection.name 不能为空");

                String name = connection.getString("name");
                String content = connection.toJSONString();
                String oldName = params.getString("oldName");

                if (oldName == null || oldName.isBlank())
                        ConnectionRepository.saveConnection(name, content);
                else
                        ConnectionRepository.updateConnection(oldName, name, content);

                return new JSONObject();
        }

        private Object deleteConnection(JSONObject params)
        {
                String name = params.getString("name");

                if (name == null || name.isBlank())
                        throw new IllegalArgumentException("name 不能为空");

                ConnectionRepository.deleteConnection(name);
                /* 连接配置都删了，它的补全快照也没用了 */
                suggestionSnapshots.keySet().removeIf(key -> key.startsWith(name + "|"));
                return new JSONObject();
        }

        /** 补全快照的键：连接名 + 库 + 模式 */
        private String snapshotKey(String connection, Session context)
        {
                return connection + "|" + context.catalog() + "|" + context.schema();
        }

        /**
         * 预热补全引擎并留下元数据快照：打开查询页时调用一次，
         * 这样即使用户没敲过字就断开连接，控制台里也已经有这份快照可用。
         */
        private Object warmSuggest(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));
                String cacheKey = session.id + "|" + context.catalog() + "|" + context.schema();
                SuggestionEngine engine = suggestionEngines.get(cacheKey);

                if (engine == null) {
                        engine = SuggestionEngine.of(session.driver, context);
                        suggestionEngines.put(cacheKey, engine);
                }

                suggestionSnapshots.put(snapshotKey(session.name, context), engine);
                return new JSONObject();
        }

        /* ********************************************************************* */
        /*                              连接会话                                  */
        /* ********************************************************************* */

        private Object openConnection(JSONObject params)
        {
                JSONObject connection = params.getJSONObject("connection");

                if (connection == null)
                        connection = findSavedConnection(params.getString("name"));

                Driver driver = DriverFactory.create(toConfig(connection));
                String sessionId = "s" + sessionSequence.incrementAndGet();
                OpenConnection session = new OpenConnection(sessionId, connection.getString("name"), driver);

                try {
                        JSONArray nodes = new JSONArray();

                        for (DBNode node : driver.getNodeHierarchy())
                                nodes.add(nodeJson(session, node));

                        sessions.put(sessionId, session);

                        JSONObject ret = new JSONObject();
                        ret.put("sessionId", sessionId);
                        ret.put("product", productJson(driver));
                        ret.put("nodes", nodes);

                        return ret;
                } catch (Throwable e) {
                        closeQuietly(driver.getDataSource());
                        throw e;
                }
        }

        private Object closeConnection(JSONObject params)
        {
                String sessionId = params.getString("sessionId");
                OpenConnection session = sessions.remove(sessionId);

                if (session != null)
                        closeQuietly(session.driver.getDataSource());

                if (sessionId != null)
                        suggestionEngines.keySet().removeIf(key -> key.startsWith(sessionId + "|"));

                if (sessionId != null) {
                        resultOwner.entrySet().removeIf(entry -> {
                                if (!sessionId.equals(entry.getValue()))
                                        return false;

                                resultCache.remove(entry.getKey());
                                return true;
                        });
                }

                return new JSONObject();
        }

        private Object schemaChildren(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                DBNode node = session.nodes.get(params.getString("nodeId"));

                if (node == null)
                        throw new IllegalArgumentException("节点不存在: " + params.getString("nodeId"));

                /* 「查询脚本」节点下的子节点不是数据库对象，而是本地脚本文件 */
                if (node instanceof DBQueryContainerNode)
                        return queryScriptNodes(session, node);

                JSONArray nodes = new JSONArray();
                List<DBNode> children = node.getChildren();

                if (children != null) {
                        for (DBNode child : children)
                                nodes.add(nodeJson(session, child));
                }

                JSONObject ret = new JSONObject();
                ret.put("nodes", nodes);
                return ret;
        }

        /**
         * 重新读取会话的顶层对象层级（连接节点上的「刷新」）。
         *
         * 不重开会话、不重连，只是让驱动再报一次当前的库 / 模式列表：
         * 重连要关掉数据源，已打开的数据页、脚本快照都会跟着作废。
         */
        private Object schemaRoots(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                JSONArray nodes = new JSONArray();

                for (DBNode node : session.driver.getNodeHierarchy())
                        nodes.add(nodeJson(session, node));

                JSONObject ret = new JSONObject();
                ret.put("nodes", nodes);
                return ret;
        }

        /* ********************************************************************* */
        /*                              查询执行                                  */
        /* ********************************************************************* */

        private Object tablePage(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));

                int offset = params.getIntValue("offset");
                int size = params.containsKey("size") ? params.getIntValue("size") : 200;

                QueryResult queryResult = session.driver.selectByPage(
                        context, params.getString("table"), offset, size);

                long jobId = System.currentTimeMillis();
                cacheResult(session.id, jobId, queryResult);

                JSONObject ret = new JSONObject();
                ret.put("jobId", jobId);
                ret.putAll(resultJson(jobId, queryResult));
                ret.put("offset", offset);
                ret.put("size", size);

                return ret;
        }

        private Object tableColumns(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));

                JSONArray columns = new JSONArray();

                for (Column column : session.driver.getColumns(context, params.getString("table")))
                        columns.add(columnJson(column));

                JSONObject ret = new JSONObject();
                ret.put("columns", columns);
                return ret;
        }

        private Object tableIndexes(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));

                JSONArray indexes = new JSONArray();

                for (Index index : session.driver.getIndexes(context, params.getString("table")))
                        indexes.add(indexJson(index));

                JSONObject ret = new JSONObject();
                ret.put("indexes", indexes);
                return ret;
        }

        private Object tableDdl(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));

                JSONObject ret = new JSONObject();
                ret.put("ddl", session.driver.showCreateTable(context, params.getString("table")));

                return ret;
        }

        /**
         * 导出单张表：结构（CREATE TABLE），可选连同数据（INSERT）。
         */
        private Object exportTableSql(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));
                String table = params.getString("table");

                if (table == null || table.isBlank())
                        throw new IllegalArgumentException("表名不能为空");

                return writeSqlDump(session.driver, context, List.of(table), params.getString("path"),
                        params.getBooleanValue("withData"), params.getString("token"));
        }

        /**
         * 导出整个数据库 / 模式下所有表：结构（CREATE TABLE），可选连同数据（INSERT）。
         */
        private Object exportDatabaseSql(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));

                List<String> tables = new ArrayList<>();

                for (Table table : session.driver.getTables(context))
                        tables.add(table.getName());

                return writeSqlDump(session.driver, context, tables, params.getString("path"),
                        params.getBooleanValue("withData"), params.getString("token"));
        }

        /**
         * 导出进度：渲染层据此画进度条弹窗。
         * phase=count 表示还在统计总行数（此时进度条走不确定动画）；
         * phase=dump 时用 rows / totalRows 算百分比，totalRows 为 0 则退回按表数。
         */
        private void exportProgress(String token, int current, int total, String table,
                long rows, long totalRows, String phase)
        {
                if (token == null || token.isBlank())
                        return;

                JSONObject payload = new JSONObject();
                payload.put("token", token);
                payload.put("current", current);
                payload.put("total", total);
                payload.put("table", table);
                payload.put("rows", rows);
                payload.put("totalRows", totalRows);
                payload.put("phase", phase);
                notify("export.progress", payload);
        }

        /** 每页读取的行数：导出数据时分页把结果拼成 INSERT，避免一次性把所有行读进内存 */
        private static final int DUMP_PAGE_SIZE = 1000;

        private static final Set<String> NUMERIC_TYPES = Set.of(
                "INT", "INTEGER", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT",
                "DECIMAL", "DEC", "NUMERIC", "NUMBER", "FLOAT", "DOUBLE", "REAL",
                "MONEY", "SMALLMONEY", "SERIAL", "BIGSERIAL", "BINARY_FLOAT", "BINARY_DOUBLE"
        );

        /** 把若干张表写成一份 SQL 脚本（结构 + 可选数据），返回写入的数据行数 */
        private JSONObject writeSqlDump(Driver driver, Session context, List<String> tables,
                String path, boolean withData, String token)
        {
                if (path == null || path.isBlank())
                        throw new IllegalArgumentException("导出路径不能为空");

                Dialect dialect = driver.getDialect();
                StringBuilder builder = new StringBuilder();
                int rowCount = 0;
                int total = tables.size();

                /* 先数一遍行数，进度条才是按真实行数走的（不数就只能按表数走，单表会看着像假的） */
                long totalRows = 0;

                if (withData) {
                        for (int index = 0; index < tables.size(); index++) {
                                String table = tables.get(index);

                                exportProgress(token, index, total, table, 0, 0, "count");
                                totalRows += countRows(driver, dialect, context, table);
                        }
                }

                exportProgress(token, 0, total, null, 0, totalRows, "dump");

                builder.append("-- Valkyrie SQL dump\n");
                builder.append("-- 数据库: ").append(context.catalog() == null ? "" : context.catalog());

                if (context.schema() != null)
                        builder.append("  模式: ").append(context.schema());

                builder.append("\n-- 时间: ")
                        .append(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").format(LocalDateTime.now()))
                        .append("\n\n");

                for (int index = 0; index < tables.size(); index++) {
                        String table = tables.get(index);

                        exportProgress(token, index, total, table, rowCount, totalRows, "dump");

                        builder.append("-- ----------------------------\n");
                        builder.append("-- 表结构: ").append(table).append("\n");
                        builder.append("-- ----------------------------\n");

                        String ddl = driver.showCreateTable(context, table).trim();

                        builder.append(ddl);
                        if (!ddl.endsWith(";"))
                                builder.append(';');

                        builder.append("\n\n");

                        if (withData) {
                                builder.append("-- 表数据: ").append(table).append("\n");

                                List<Column> columns = null;
                                int offset = 0;

                                while (true) {
                                        QueryResult result = driver.selectByPage(context, table, offset, DUMP_PAGE_SIZE);
                                        List<GridRow> rows = result.getRows();

                                        if (columns == null)
                                                columns = result.getColumns();

                                        for (GridRow row : rows) {
                                                builder.append(dumpInsert(dialect, table, columns, row)).append('\n');
                                                rowCount++;
                                        }

                                        exportProgress(token, index, total, table, rowCount, totalRows, "dump");

                                        if (rows.size() < DUMP_PAGE_SIZE)
                                                break;

                                        offset += rows.size();
                                }

                                builder.append('\n');
                        }

                        exportProgress(token, index + 1, total, table, rowCount, totalRows, "dump");
                }

                /* 收尾：行数可能因精确统计而有出入，明确报一次进度，进度条才会走到 100% */
                exportProgress(token, total, total, null, rowCount, Math.max(totalRows, rowCount), "dump");

                try {
                        Files.writeString(Path.of(path), builder, StandardCharsets.UTF_8);
                } catch (Exception e) {
                        throw new CoreException(e);
                }

                JSONObject ret = new JSONObject();
                ret.put("path", path);
                ret.put("tables", tables.size());
                ret.put("rows", rowCount);

                return ret;
        }

        /** 统计表行数用于进度条分母；失败返回 0（不影响导出，只是该表不参与百分比） */
        private long countRows(Driver driver, Dialect dialect, Session context, String table)
        {
                try {
                        QueryResult result = driver.execute(context,
                                new SQL("SELECT COUNT(*) FROM " + dialect.quote(table)));
                        List<GridRow> rows = result.getRows();

                        if (!rows.isEmpty() && !rows.getFirst().isEmpty()) {
                                String value = rows.getFirst().get(0);

                                if (value != null && !value.isBlank())
                                        return Long.parseLong(value.trim());
                        }
                } catch (Exception e) {
                        LOG.debug("统计表 {} 行数失败，导出进度将不包含该表", table, e);
                }

                return 0;
        }

        private String dumpInsert(Dialect dialect, String table, List<Column> columns, GridRow row)
        {
                StringBuilder builder = new StringBuilder("INSERT INTO ")
                        .append(dialect.quote(table))
                        .append(" (");

                for (int i = 0; i < columns.size(); i++) {
                        if (i > 0)
                                builder.append(", ");

                        builder.append(dialect.quote(columns.get(i).getName()));
                }

                builder.append(") VALUES (");

                for (int i = 0; i < columns.size(); i++) {
                        if (i > 0)
                                builder.append(", ");

                        builder.append(dumpLiteral(i < row.size() ? row.get(i) : null, columns.get(i).getType()));
                }

                return builder.append(");").toString();
        }

        /** 单元格文本 → SQL 字面量：数值 / 布尔裸写，其余单引号转义 */
        private String dumpLiteral(String value, String type)
        {
                if (value == null)
                        return "NULL";

                String upper = type == null ? "" : type.toUpperCase(Locale.ROOT);

                if (isNumericType(upper) && value.matches("-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?"))
                        return value;

                if (upper.contains("BOOL")) {
                        if (value.equalsIgnoreCase("true") || value.equalsIgnoreCase("t") || value.equals("1"))
                                return "TRUE";

                        if (value.equalsIgnoreCase("false") || value.equalsIgnoreCase("f") || value.equals("0"))
                                return "FALSE";
                }

                return "'" + value.replace("'", "''") + "'";
        }

        private boolean isNumericType(String type)
        {
                for (String token : type.split("[^A-Za-z0-9_]+"))
                        if (NUMERIC_TYPES.contains(token))
                                return true;

                return false;
        }

        /**
         * 保存表设计（设计表页的「保存」）。
         *
         * 界面发来的是整张表的目标状态（字段 + 索引），这里和库里的现状做差再下发，
         * 顺序与 FX 版一致：主键要动先把自增摘掉（MySQL 不允许直接改带自增的主键）→
         * 字段新增 / 修改 → 删字段 → 重建主键 → 恢复自增 → 索引增删改。
         *
         * 字段与索引都按名字对号入座；改过名的会带上 originalName，用来定位原来那一行。
         */
        private Object designTable(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));
                String table = params.getString("table");
                Driver driver = session.driver;

                List<Column> original = driver.getColumns(context, table);
                List<Column> wanted = parseColumns(params.getJSONArray("columns"));
                List<Index> originalIndexes = driver.getIndexes(context, table);
                List<Index> wantedIndexes = parseIndexes(params.getJSONArray("indexes"));

                Map<String, Column> existing = new LinkedHashMap<>();

                for (Column column : original)
                        existing.put(column.getName(), column);

                List<Column> added = new ArrayList<>();
                List<Column> changed = new ArrayList<>();
                List<String> kept = new ArrayList<>();

                for (Column column : wanted) {
                        String lookup = column.getOriginalName() != null ? column.getOriginalName() : column.getName();
                        Column before = existing.get(lookup);

                        if (before == null) {
                                added.add(column);
                                continue;
                        }

                        kept.add(before.getName());

                        if (!sameColumn(before, column)) {
                                /* 交给驱动的 CHANGE 分支：改名与改类型走同一条路 */
                                column.setOriginalName(before.getName());
                                changed.add(column);
                        }
                }

                List<Column> removed = new ArrayList<>();

                for (Column column : original)
                        if (!kept.contains(column.getName()))
                                removed.add(column);

                List<Column> wantedPrimary = new ArrayList<>();
                List<Column> originalPrimary = new ArrayList<>();

                for (Column column : wanted)
                        if (column.isPrimary())
                                wantedPrimary.add(column);

                for (Column column : original)
                        if (column.isPrimary())
                                originalPrimary.add(column);

                boolean primaryChanged = !samePrimary(originalPrimary, wantedPrimary);
                List<Column> autoIncrements = new ArrayList<>();

                if (primaryChanged) {
                        for (Column column : originalPrimary)
                                if (column.isAutoIncrement()) {
                                        column.setAutoIncrement(false);
                                        autoIncrements.add(column);
                                }

                        if (!autoIncrements.isEmpty())
                                driver.alterChange(context, table, autoIncrements);
                }

                List<Column> alters = new ArrayList<>(added);

                alters.addAll(changed);

                if (!alters.isEmpty())
                        driver.alterChange(context, table, alters);

                if (!removed.isEmpty())
                        driver.dropColumns(context, table, removed);

                if (primaryChanged) {
                        driver.dropPrimaryKey(context, table);

                        if (!wantedPrimary.isEmpty())
                                driver.addPrimaryKey(context, table, wantedPrimary);

                        if (!autoIncrements.isEmpty()) {
                                autoIncrements.forEach(column -> column.setAutoIncrement(true));
                                driver.alterChange(context, table, autoIncrements);
                        }
                }

                applyIndexDesign(driver, context, table, originalIndexes, wantedIndexes);

                JSONObject ret = new JSONObject();
                JSONArray columns = new JSONArray();
                JSONArray indexes = new JSONArray();

                for (Column column : driver.getColumns(context, table))
                        columns.add(columnJson(column));

                for (Index index : driver.getIndexes(context, table))
                        indexes.add(indexJson(index));

                ret.put("columns", columns);
                ret.put("indexes", indexes);
                ret.put("ddl", driver.showCreateTable(context, table));
                return ret;
        }

        /** 索引：改过结构的先删后建，只改可见性的走 alterVisible，不要的删掉 */
        private void applyIndexDesign(
                Driver driver, Session context, String table,
                List<Index> original, List<Index> wanted)
        {
                Map<String, Index> existing = new LinkedHashMap<>();

                for (Index index : original)
                        existing.put(index.getName(), index);

                List<Index> upserts = new ArrayList<>();
                List<Index> visibility = new ArrayList<>();
                List<String> kept = new ArrayList<>();

                for (Index index : wanted) {
                        String lookup = index.getOriginalName() != null ? index.getOriginalName() : index.getName();
                        Index before = existing.get(lookup);

                        if (before == null) {
                                upserts.add(index);
                                continue;
                        }

                        kept.add(before.getName());

                        boolean structureChanged = !Objects.equals(before.getName(), index.getName())
                                || !Objects.equals(normalizeIndexText(before.getColumnsText()), normalizeIndexText(index.getColumnsText()))
                                || !Objects.equals(normalizeIndexText(before.getType()), normalizeIndexText(index.getType()));

                        if (structureChanged) {
                                index.setOriginalName(before.getName());
                                upserts.add(index);
                        } else if (before.isVisible() != index.isVisible()) {
                                visibility.add(index);
                        }
                }

                /*
                 * 先后顺序很重要：
                 * 1) 全新索引先建 —— 驱动不支持建索引时直接报错，库里现有索引一个都没动；
                 * 2) 改动过的索引才「先删后建」（驱动不支持时仍会丢，这点和 FX 版一致）；
                 * 3) 最后删用户删掉的。
                 */
                List<Index> fresh = new ArrayList<>();
                List<Index> changed = new ArrayList<>();

                for (Index index : upserts) {
                        if (index.getOriginalName() == null)
                                fresh.add(index);
                        else
                                changed.add(index);
                }

                if (!fresh.isEmpty())
                        driver.alterIndexKeys(context, table, fresh);

                if (!changed.isEmpty()) {
                        driver.dropIndexKeys(context, table, changed);
                        driver.alterIndexKeys(context, table, changed);
                }

                if (!visibility.isEmpty())
                        driver.alterVisible(context, table, visibility);

                for (Index index : original)
                        if (!kept.contains(index.getName()))
                                driver.dropIndexKeys(context, table, List.of(index));
        }

        private boolean sameColumn(Column before, Column after)
        {
                return Objects.equals(before.getName(), after.getName())
                        && Objects.equals(before.getType(), after.getType())
                        && Objects.equals(normalize(before.getDefaultValue()), normalize(after.getDefaultValue()))
                        && Objects.equals(normalize(before.getComment()), normalize(after.getComment()))
                        && before.isNotNull() == after.isNotNull()
                        && before.isAutoIncrement() == after.isAutoIncrement();
        }

        private boolean samePrimary(List<Column> before, List<Column> after)
        {
                if (before.size() != after.size())
                        return false;

                for (int index = 0; index < before.size(); index++)
                        if (!Objects.equals(before.get(index).getName(), after.get(index).getName()))
                                return false;

                return true;
        }

        private String normalize(String value)
        {
                return value == null || value.isBlank() ? null : value.trim();
        }

        /** 索引比较用：去空白 + 忽略大小写（驱动给出的 columnsText 可能带多余空格） */
        private String normalizeIndexText(String value)
        {
                return value == null ? null : value.trim().replaceAll("\\s+", " ").toUpperCase();
        }

        private JSONObject columnJson(Column column)
        {
                JSONObject json = new JSONObject();
                json.put("label", column.getLabel());
                json.put("name", column.getName());
                json.put("type", column.getType());
                json.put("index", column.getIndex());
                json.put("primary", column.isPrimary());
                json.put("notNull", column.isNotNull());
                json.put("autoIncrement", column.isAutoIncrement());
                json.put("defaultValue", column.getDefaultValue());
                json.put("comment", column.getComment());
                return json;
        }

        private JSONObject indexJson(Index index)
        {
                JSONObject json = new JSONObject();
                json.put("name", index.getName());
                json.put("columnsText", index.getColumnsText());
                json.put("type", index.getType());
                json.put("visible", index.isVisible());
                return json;
        }

        private List<Column> parseColumns(JSONArray array)
        {
                List<Column> columns = new ArrayList<>();

                if (array == null)
                        return columns;

                for (int index = 0; index < array.size(); index++) {
                        JSONObject json = array.getJSONObject(index);
                        Column column = new Column();

                        column.setName(json.getString("name"));
                        column.setOriginalName(json.getString("originalName"));
                        column.setType(json.getString("type"));
                        column.setDefaultValue(json.getString("defaultValue"));
                        column.setComment(json.getString("comment"));
                        column.setNotNull(json.getBooleanValue("notNull"));
                        column.setPrimary(json.getBooleanValue("primary"));
                        column.setAutoIncrement(json.getBooleanValue("autoIncrement"));
                        columns.add(column);
                }

                return columns;
        }

        private List<Index> parseIndexes(JSONArray array)
        {
                List<Index> indexes = new ArrayList<>();

                if (array == null)
                        return indexes;

                for (int index = 0; index < array.size(); index++) {
                        JSONObject json = array.getJSONObject(index);
                        Index item = new Index();

                        item.setName(json.getString("name"));
                        item.setOriginalName(json.getString("originalName"));
                        item.setColumnsText(json.getString("columnsText"));
                        item.setType(json.getString("type"));
                        item.setVisible(!json.containsKey("visible") || json.getBooleanValue("visible"));
                        item.setOriginalVisible(item.isVisible());
                        indexes.add(item);
                }

                return indexes;
        }

        private Object formatSql(JSONObject params)
        {
                String sql = params.getString("sql");

                JSONObject ret = new JSONObject();
                ret.put("sql", sql == null || sql.isBlank() ? sql : SqlFormatter.format(sql));

                return ret;
        }

        /**
         * SQL 智能提示：按光标所在的 FROM / JOIN 上下文过滤表与字段。
         * <p>
         * 引擎构建需要读取库表元数据，这里按「会话 + catalog + schema」缓存，
         * {@code resolve} 本身是纯内存计算，可以随每次按键调用。
         */
        private Object suggestSql(JSONObject params)
        {
                String sql = params.getString("sql");
                JSONArray suggestions = new JSONArray();

                if (sql == null || sql.isBlank())
                        return suggestionResult(suggestions);

                /*
                 * 会话可选：连接已关闭时用 type 给出该方言的关键字提示，
                 * 有会话时才带上表名与字段（那部分依赖元数据）。
                 */
                String sessionId = params.getString("sessionId");
                OpenConnection session = sessionId == null ? null : sessions.get(sessionId);
                String type = params.getString("type");
                String connection = params.getString("connection");
                Session context = Session.of(params.getString("catalog"), params.getString("schema"));
                int offset = params.containsKey("offset")
                        ? Math.min(params.getIntValue("offset"), sql.length())
                        : sql.length();

                SuggestionEngine engine = null;

                if (session != null) {
                        String cacheKey = session.id + "|" + context.catalog() + "|" + context.schema();

                        engine = suggestionEngines.get(cacheKey);

                        if (engine == null) {
                                engine = SuggestionEngine.of(session.driver, context);
                                suggestionEngines.put(cacheKey, engine);
                        }

                        /* 同步留一份「连接级」快照：连接关闭后查询控制台靠它继续提示 */
                        suggestionSnapshots.put(snapshotKey(session.name, context), engine);
                } else if (connection != null) {
                        engine = suggestionSnapshots.get(snapshotKey(connection, context));
                }

                /* 既没有会话也没有快照：退回该方言的关键字 */
                if (engine == null) {
                        String cacheKey = "type|" + (type == null ? "sql" : type.toLowerCase());

                        engine = suggestionEngines.computeIfAbsent(cacheKey, key -> SuggestionEngine.keywords(type));
                }

                for (Suggestion suggestion : engine.resolve(sql, offset)) {
                        JSONObject json = new JSONObject();
                        json.put("label", suggestion.getLabel());
                        json.put("kind", suggestion.getKind());
                        json.put("insertText", suggestion.getInsertText());
                        json.put("detail", suggestion.getDetail());
                        suggestions.add(json);
                }

                return suggestionResult(suggestions);
        }

        private JSONObject suggestionResult(JSONArray suggestions)
        {
                JSONObject ret = new JSONObject();
                ret.put("suggestions", suggestions);
                return ret;
        }

        private Object executeQuery(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                String raw = params.getString("sql");

                if (raw == null || raw.isBlank())
                        throw new IllegalArgumentException("sql 不能为空");

                Session context = Session.of(params.getString("catalog"), params.getString("schema"));
                long jobId = params.containsKey("jobId")
                        ? params.getLongValue("jobId")
                        : System.currentTimeMillis();
                String sessionId = session.id;

                QueryResult queryResult = session.driver.execute(jobId, context, new SQL(raw),
                        new SQLExecuteCallback()
                        {
                                @Override
                                public void execute(String sql)
                                {
                                        progress(sessionId, jobId, "execute", sql);
                                }

                                @Override
                                public void executeQuery(String sql, boolean skip)
                                {
                                        progress(sessionId, jobId, skip ? "skip" : "query", sql);
                                }

                                @Override
                                public void executeUpdate(String sql)
                                {
                                        progress(sessionId, jobId, "update", sql);
                                }

                                @Override
                                public void row(int value)
                                {
                                        progress(sessionId, jobId, "rows", String.valueOf(value));
                                }

                                @Override
                                public void cost(long time)
                                {
                                        progress(sessionId, jobId, "cost", String.valueOf(time));
                                }
                        });

                JSONObject ret = new JSONObject();
                ret.put("jobId", jobId);
                ret.put("hasResultSet", queryResult != null);

                /* DDL 之后元数据变了，丢弃该会话缓存的智能提示引擎 */
                if (raw.matches("(?is).*\\b(create|drop|alter|truncate|rename)\\b.*"))
                        suggestionEngines.keySet().removeIf(key -> key.startsWith(sessionId + "|"));

                if (queryResult != null) {
                        cacheResult(sessionId, jobId, queryResult);
                        ret.putAll(resultJson(jobId, queryResult));
                }

                return ret;
        }

        private Object cancelQuery(JSONObject params)
        {
                OpenConnection session = require(params.getString("sessionId"));
                session.driver.cancel(params.getLongValue("jobId"));

                return new JSONObject();
        }

        private void progress(String sessionId, long jobId, String kind, String detail)
        {
                JSONObject payload = new JSONObject();
                payload.put("sessionId", sessionId);
                payload.put("jobId", jobId);
                payload.put("kind", kind);
                payload.put("detail", detail);

                notify("query.progress", payload);
        }

        /* ********************************************************************* */
        /*                              序列化                                    */
        /* ********************************************************************* */

        private JSONObject nodeJson(OpenConnection session, DBNode node)
        {
                /*
                 * 节点 id 带上会话前缀：界面把节点 id 当全局键用（树缓存 / 展开状态 / 父节点回溯），
                 * 多连接并存时每个会话各自从 n1 开始编号会互相撞车，进而串到别的连接上。
                 */
                String id = session.id + ":n" + session.nodeSequence.incrementAndGet();
                session.nodes.put(id, node);

                JSONObject json = new JSONObject();
                json.put("id", id);
                json.put("label", node.getLabel());
                json.put("kind", node.getKind().name());
                json.put("icon", node.getKind().getIcon());
                /* 「查询脚本」容器的子节点是本地脚本文件，驱动本身不感知，这里按可展开上报 */
                json.put("hasChildren", node.hasChildren() || node instanceof DBQueryContainerNode);

                /* 节点所属的 catalog / schema 供前端做分页、表结构查询使用 */
                Session nodeSession = switch (node) {
                        case DBCatalogNode catalog -> catalog.getSession();
                        case DBSchemaNode schema -> schema.getSession();
                        case DBTableContainerNode container -> container.getSession();
                        case DBObjectContainerNode container -> container.getSession();
                        default -> null;
                };

                if (nodeSession != null) {
                        json.put("catalog", nodeSession.catalog());
                        json.put("schema", nodeSession.schema());
                }

                if (node instanceof DBTableNode tableNode) {
                        json.put("table", tableMetaJson(tableNode.getTable()));
                } else if (node instanceof DBObjectNode objectNode) {
                        json.put("table", tableMetaJson(objectNode.getTable()));
                } else if (node instanceof DBColumnNode columnNode) {
                        Column column = columnNode.getColumn();
                        JSONObject meta = new JSONObject();
                        meta.put("name", column.getName());
                        meta.put("type", column.getType());
                        meta.put("notNull", column.isNotNull());
                        meta.put("primary", column.isPrimary());
                        meta.put("autoIncrement", column.isAutoIncrement());
                        meta.put("defaultValue", column.getDefaultValue());
                        meta.put("comment", column.getComment());
                        json.put("column", meta);
                } else if (node instanceof DBIndexNode indexNode) {
                        Index index = indexNode.getIndex();
                        JSONObject meta = new JSONObject();
                        meta.put("name", index.getName());
                        meta.put("columnsText", index.getColumnsText());
                        meta.put("type", index.getType());
                        meta.put("visible", index.isVisible());
                        json.put("index", meta);
                } else if (node instanceof DBForeignKeyNode foreignKeyNode) {
                        ForeignKey foreignKey = foreignKeyNode.getForeignKey();
                        JSONObject meta = new JSONObject();
                        meta.put("name", foreignKey.getName());
                        meta.put("columnsText", foreignKey.getColumnsText());
                        meta.put("refTable", foreignKey.getRefTable());
                        meta.put("refColumnsText", foreignKey.getRefColumnsText());
                        json.put("foreignKey", meta);
                }

                return json;
        }

        private JSONObject tableMetaJson(Table table)
        {
                JSONObject meta = new JSONObject();
                meta.put("name", table.getName());
                meta.put("engine", table.getEngine());
                meta.put("rows", table.getRows());
                meta.put("size", table.getSize());
                meta.put("comment", table.getComment());
                meta.put("createTime", table.getCreateTime() == null ? null : table.getCreateTime().getTime());
                meta.put("updateTime", table.getUpdateTime() == null ? null : table.getUpdateTime().getTime());
                return meta;
        }

        private JSONObject productJson(Driver driver)
        {
                JSONObject json = new JSONObject();
                var meta = driver.getProductMetaData();

                if (meta != null) {
                        json.put("productName", meta.getProductName());
                        json.put("version", meta.getVersion());
                        json.put("majorVersion", meta.getMajorVersion());
                        json.put("minorVersion", meta.getMinorVersion());
                }

                json.put("type", driver.getType().name());
                return json;
        }

        private JSONArray columnsJson(QueryResult queryResult)
        {
                JSONArray columns = new JSONArray();

                for (Column column : queryResult.getColumns()) {
                        JSONObject json = new JSONObject();
                        json.put("label", column.getLabel());
                        json.put("name", column.getName());
                        json.put("type", column.getType());
                        json.put("primary", column.isPrimary());
                        json.put("notNull", column.isNotNull());
                        json.put("autoIncrement", column.isAutoIncrement());
                        json.put("comment", column.getComment());
                        json.put("defaultValue", column.getDefaultValue());
                        columns.add(json);
                }

                return columns;
        }

        private JSONArray rowsJson(QueryResult queryResult)
        {
                return rowsJson(queryResult, false);
        }

        /**
         * 行数据；{@code mergeBuffer} 为 true 时把未提交的修改合并进来，
         * 让前端直接看到"改过但未提交"的效果。
         */
        private JSONArray rowsJson(QueryResult queryResult, boolean mergeBuffer)
        {
                JSONArray rows = new JSONArray();
                var buffer = mergeBuffer ? queryResult.getUpdateRowBuffer() : Map.<Integer, GridRow>of();

                for (int index = 0; index < queryResult.getRows().size(); index++) {
                        GridRow row = buffer.containsKey(index) ? buffer.get(index) : queryResult.getRows().get(index);
                        rows.add(new JSONArray(row));
                }

                return rows;
        }

        /* ********************************************************************* */
        /*                          结果集编辑                                    */
        /* ********************************************************************* */

        private void cacheResult(String sessionId, long jobId, QueryResult queryResult)
        {
                if (queryResult == null)
                        return;

                resultCache.put(jobId, queryResult);
                resultOwner.put(jobId, sessionId);
        }

        private QueryResult requireResult(JSONObject params)
        {
                long jobId = params.getLongValue("jobId");
                QueryResult result = resultCache.get(jobId);

                if (result == null)
                        throw new IllegalArgumentException("结果集已失效，请重新执行查询");

                return result;
        }

        /**
         * 结果集回传：列、行、是否可编辑/可插入、是否有未提交修改。
         */
        private JSONObject resultJson(long jobId, QueryResult queryResult)
        {
                JSONObject ret = new JSONObject();
                /* 回传 jobId，前端后续的编辑/提交/删除都基于同一个结果集 */
                ret.put("jobId", jobId);
                ret.put("hasResultSet", true);
                ret.put("columns", columnsJson(queryResult));
                ret.put("rows", rowsJson(queryResult, true));
                ret.put("editable", queryResult.isEditable());
                ret.put("addable", queryResult.isAddable());
                ret.put("dirty", queryResult.isDirty());
                /* 待删除但还没提交的行：界面把它们标出来，提交后才真的消失 */
                ret.put("deletedRows", new JSONArray(queryResult.getDeleteRowBuffer().stream().sorted().toList()));

                return ret;
        }

        private Object updateCell(JSONObject params)
        {
                QueryResult result = requireResult(params);

                result.addUpdateRow(
                        params.getIntValue("col"),
                        params.getIntValue("row"),
                        params.containsKey("value") ? params.getString("value") : null);

                return resultJson(params.getLongValue("jobId"), result);
        }

        private Object setNull(JSONObject params)
        {
                QueryResult result = requireResult(params);

                for (int row : toIntArray(params.getJSONArray("rows"))) {
                        for (int col : toIntArray(params.getJSONArray("cols")))
                                result.addUpdateRow(col, row, null);
                }

                return resultJson(params.getLongValue("jobId"), result);
        }

        private Object insertRow(JSONObject params)
        {
                QueryResult result = requireResult(params);

                result.addEmptyRow();

                return resultJson(params.getLongValue("jobId"), result);
        }

        private Object deleteRows(JSONObject params)
        {
                QueryResult result = requireResult(params);
                List<Integer> indices = new ArrayList<>();

                for (int index : toIntArray(params.getJSONArray("rows")))
                        indices.add(index);

                /* 只记进待提交缓冲：点「提交修改」才真正 DELETE，中途可以「回滚」 */
                result.remove(indices);

                return resultJson(params.getLongValue("jobId"), result);
        }

        private Object commitResult(JSONObject params)
        {
                QueryResult result = requireResult(params);

                result.update();

                return resultJson(params.getLongValue("jobId"), result);
        }

        private Object rollbackResult(JSONObject params)
        {
                QueryResult result = requireResult(params);

                result.clearUpdateBuffer();

                return resultJson(params.getLongValue("jobId"), result);
        }

        private Object reloadResult(JSONObject params)
        {
                QueryResult result = requireResult(params);

                result.reload();
                result.clearUpdateBuffer();

                return resultJson(params.getLongValue("jobId"), result);
        }

        private int[] toIntArray(JSONArray array)
        {
                if (array == null)
                        return new int[0];

                int[] values = new int[array.size()];

                for (int i = 0; i < array.size(); i++)
                        values[i] = array.getIntValue(i);

                return values;
        }

        /* ********************************************************************* */
        /*                          查询脚本文件                                  */
        /* ********************************************************************* */

        /** 脚本目录：<连接配置目录>/<连接名>/<数据库名> */
        private String scriptBasePath(OpenConnection session, DBNode node)
        {
                return session.name + "/" + catalogOf(node);
        }

        /** 沿父链找到所属的数据库（或模式）名 */
        private String catalogOf(DBNode node)
        {
                DBNode current = node;

                while (current != null) {
                        if (current instanceof DBCatalogNode catalog)
                                return catalog.getLabel();

                        if (current instanceof DBSchemaNode schema)
                                return schema.getLabel();

                        current = current.getParent();
                }

                return "default";
        }

        private JSONObject queryScriptNodes(OpenConnection session, DBNode node)
        {
                JSONArray nodes = new JSONArray();

                for (QueryFile file : QueryFileRepository.loadScriptFiles(scriptBasePath(session, node))) {
                        if (!file.isFile())
                                continue;

                        JSONObject json = new JSONObject();
                        json.put("id", "script:" + file.getAbsolutePath());
                        json.put("label", file.getName());
                        json.put("kind", "QUERY");
                        json.put("hasChildren", false);
                        json.put("path", file.getAbsolutePath());
                        /* 打开脚本要用「连接/数据库/文件名」拼路径，树节点必须带上所属数据库 */
                        json.put("catalog", catalogOf(node));
                        json.put("size", file.length());
                        json.put("modified", file.lastModified());
                        nodes.add(json);
                }

                JSONObject ret = new JSONObject();
                ret.put("nodes", nodes);
                return ret;
        }

        private Object listQueryFiles(JSONObject params)
        {
                String connection = requiredText(params, "connection");
                String catalog = params.getString("catalog");

                JSONArray files = new JSONArray();

                /* 不指定数据库：列出该连接下全部数据库目录里的脚本（脚本对象页用） */
                List<QueryFile> scripts = catalog == null || catalog.isBlank()
                        ? QueryFileRepository.loadConnectionScripts(connection)
                        : QueryFileRepository.loadScriptFiles(connection + "/" + catalog);

                for (QueryFile file : scripts) {
                        JSONObject json = new JSONObject();
                        json.put("name", file.getName());
                        json.put("path", file.getAbsolutePath());
                        json.put("catalog", file.getParentFile() == null ? "" : file.getParentFile().getName());
                        json.put("size", file.length());
                        json.put("modified", file.lastModified());
                        files.add(json);
                }

                JSONObject ret = new JSONObject();
                ret.put("files", files);
                ret.put("connection", connection);
                return ret;
        }

        private Object readQueryFile(JSONObject params)
        {
                String basePath = requiredText(params, "connection")
                        + "/" + params.getString("catalog") + "/" + params.getString("name");

                JSONObject ret = new JSONObject();
                ret.put("content", QueryFileRepository.getFile(basePath).strread());

                return ret;
        }

        private Object saveQueryFile(JSONObject params)
        {
                String basePath = requiredText(params, "connection")
                        + "/" + params.getString("catalog") + "/" + params.getString("name");

                QueryFile file = QueryFileRepository.write(basePath, params.getString("content"));

                JSONObject ret = new JSONObject();
                ret.put("name", file.getName());
                ret.put("path", file.getAbsolutePath());

                return ret;
        }

        private Object renameQueryFile(JSONObject params)
        {
                String prefix = requiredText(params, "connection") + "/" + params.getString("catalog") + "/";
                QueryFile source = QueryFileRepository.getFile(prefix + params.getString("oldName"));

                if (!source.exists())
                        throw new IllegalArgumentException("脚本不存在: " + params.getString("oldName"));

                QueryFile target = QueryFileRepository.rename(source, params.getString("newName"));

                JSONObject ret = new JSONObject();
                ret.put("name", target.getName());
                ret.put("path", target.getAbsolutePath());

                return ret;
        }

        private Object deleteQueryFile(JSONObject params)
        {
                String basePath = requiredText(params, "connection")
                        + "/" + params.getString("catalog") + "/" + params.getString("name");

                QueryFileRepository.getFile(basePath).forceDelete();

                return new JSONObject();
        }

        /**
         * 导出结果集：CSV 直接写文本，XLSX 交给工具模块的 POI 封装。
         */
        private Object exportResult(JSONObject params)
        {
                QueryResult result = requireResult(params);
                String path = params.getString("path");
                String format = params.getString("format");

                if (path == null || path.isBlank())
                        throw new IllegalArgumentException("导出路径不能为空");

                if ("csv".equalsIgnoreCase(format)) {
                        StringBuilder builder = new StringBuilder();

                        for (int i = 0; i < result.getColumns().size(); i++) {
                                if (i > 0)
                                        builder.append(',');

                                builder.append(csv(result.getColumns().get(i).getLabel()));
                        }

                        builder.append("\r\n");

                        for (GridRow row : result.getRows()) {
                                for (int i = 0; i < row.size(); i++) {
                                        if (i > 0)
                                                builder.append(',');

                                        builder.append(csv(row.get(i)));
                                }

                                builder.append("\r\n");
                        }

                        try {
                                /* 带 BOM，Excel 打开中文不乱码 */
                                Files.writeString(Path.of(path), "\uFEFF" + builder, StandardCharsets.UTF_8);
                        } catch (Exception e) {
                                throw new CoreException(e);
                        }
                } else {
                        WorkBook workBook = WorkBook.create();
                        workBook.addRow(result.getColumns().stream().map(Column::getLabel).toArray());
                        result.getRows().forEach(row -> workBook.addRow(row.toArray()));
                        workBook.transferTo(path);
                }

                JSONObject ret = new JSONObject();
                ret.put("path", path);
                ret.put("rows", result.getRows().size());

                return ret;
        }

        private String csv(String value)
        {
                if (value == null)
                        return "";

                if (value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r"))
                        return "\"" + value.replace("\"", "\"\"") + "\"";

                return value;
        }

        /* ********************************************************************* */
        /*                              辅助                                      */
        /* ********************************************************************* */

        private JSONObject findSavedConnection(String name)
        {
                if (name == null || name.isBlank())
                        throw new IllegalArgumentException("name 或 connection 必须提供其一");

                for (DiskSavedConnection connection : ConnectionRepository.loadConnections()) {
                        if (name.equals(connection.getName()))
                                return JSON.parseObject(JSON.toJSONString(connection));
                }

                throw new IllegalArgumentException("连接不存在: " + name);
        }

        private ConnectionConfig toConfig(JSONObject connection)
        {
                ConnectionConfig config = new ConnectionConfig();

                config.setType(DbType.of(connection.getString("type")));
                config.setHost(connection.getString("host"));
                config.setPort(connection.getString("port"));
                config.setUsername(connection.getString("username"));
                config.setPassword(connection.getString("password"));
                config.setDefaultDatabase(connection.getString("db"));
                config.setJdbcUrl(connection.getString("jdbcUrl"));

                return config;
        }

        private OpenConnection require(String sessionId)
        {
                OpenConnection session = sessionId == null ? null : sessions.get(sessionId);

                if (session == null)
                        throw new IllegalArgumentException("会话不存在或已关闭: " + sessionId);

                return session;
        }

        /** 必填字符串参数（注意：连接名之类的普通文本不能用 require，那是校验会话号的） */
        private String requiredText(JSONObject params, String key)
        {
                String value = params.getString(key);

                if (value == null || value.isBlank())
                        throw new IllegalArgumentException(key + " 不能为空");

                return value;
        }

        private void closeQuietly(VkDataSource dataSource)
        {
                if (dataSource == null)
                        return;

                try {
                        dataSource.close();
                } catch (Exception e) {
                        LOG.warn("关闭数据源失败", e);
                }
        }

        public void shutdown()
        {
                /* 先让已提交的请求执行完，再释放数据源，避免最后一批响应被截断 */
                workers.shutdown();

                try {
                        if (!workers.awaitTermination(10, TimeUnit.SECONDS))
                                workers.shutdownNow();
                } catch (InterruptedException e) {
                        workers.shutdownNow();
                        Thread.currentThread().interrupt();
                }

                for (OpenConnection session : sessions.values())
                        closeQuietly(session.driver.getDataSource());

                sessions.clear();
        }

        private static final class OpenConnection
        {
                private final String id;
                private final Driver driver;
                private final Map<String, DBNode> nodes = new ConcurrentHashMap<>();
                private final AtomicLong nodeSequence = new AtomicLong();

        private final String name;

        private OpenConnection(String id, String name, Driver driver)
        {
                this.id = id;
                this.name = name;
                this.driver = driver;
        }
        }
}
