package valkyrie.driver.redis;

import redis.clients.jedis.Jedis;
import redis.clients.jedis.commands.ProtocolCommand;
import valkyrie.driver.api.*;
import valkyrie.driver.api.exception.DriverException;
import valkyrie.driver.api.node.DBNode;
import valkyrie.driver.api.node.DBNodeKind;
import valkyrie.driver.api.node.DBNodePath;
import valkyrie.driver.api.sql.SQL;
import valkyrie.driver.suggestion.Suggestion;
import valkyrie.utils.collection.Lists;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;

import static valkyrie.utils.TypeConverter.atos;
import static valkyrie.utils.string.StrStaticImports.strip;

/**
 * Redis 驱动层实现
 *
 * @author Luo Tiansheng
 * @since 2026/4/20
 */
public class RedisDriver extends Driver
{

        private final Jedis jedis;

        /**
         * 构造一个新的驱动实例。
         *
         * @param dataSource 数据源，用于获取数据库连接（不能为 {@code null}）
         * @throws NullPointerException 如果 {@code dataSource} 为 {@code null}
         */
        public RedisDriver(VkDataSource dataSource) {
                super(dataSource);
                this.jedis = ((RedisDataSource) dataSource).getJedis();
        }

        private static Integer parseCatalogLabel(String label)
        {
                return Integer.valueOf(label.substring(2, label.indexOf(" (")));
        }

        /*
         * Jedis 不是线程安全的，而 RpcServer 用多个工作线程调用同一个驱动实例。
         * 这里把会用到 Jedis 的方法串行化（同一连接内的 Redis 操作本就无并行意义），
         * 避免并发 select / sendCommand 把连接状态搞乱。
         */
        @Override
        public synchronized List<String> getCatalogs() {
                List<String> catalogs = Lists.newArrayList();
                int count = Integer.parseInt(jedis.configGet("databases").get("databases"));

                for (int i = 0; i < count; i++) {
                        jedis.select(i);
                        long dbSize = jedis.dbSize();
                        if (dbSize > 0)
                                catalogs.add(String.valueOf(i));
                }

                return catalogs;
        }

        @Override
        public synchronized QueryResult execute(long jobId, Session session, SQL sql, SQLExecuteCallback callback)
        {
                String currentCommandRef;

                try {
                        jedis.select(Integer.parseInt(session.catalog()));
                        currentCommandRef = sql.getRaw();
                        callback.execute(currentCommandRef);
                        String[] parts = strip(currentCommandRef).split("\\s+");
                        ProtocolCommand cmd = () -> parts[0].getBytes(StandardCharsets.UTF_8);
                        byte[][] args = new byte[parts.length - 1][];

                        for (int i = 1; i < parts.length; i++)
                                args[i - 1] = parts[i].getBytes(StandardCharsets.UTF_8);

                        // GET serviceCalendar|2026-04
                        Object result = jedis.sendCommand(cmd, args);

                        long startTime = System.currentTimeMillis();

                        var ret = switch (result) {
                                case null -> QueryResult.ofValue(session, null);
                                case byte[] b -> QueryResult.ofValue(session, atos(b));
                                case Long l -> QueryResult.ofValue(session, atos(l));
                                case List<?> list -> {
                                        List<?> mut = list;

                                        if (mut.isEmpty())
                                                yield QueryResult.ofList(session, List.of());

                                        List<String> values = new ArrayList<>();
                                        Object second = mut.get(1);

                                        if (second instanceof List<?> byteList)
                                                mut = byteList;

                                        for (Object v : mut)
                                                values.add(atos((byte[]) v));

                                        yield QueryResult.ofList(session, values);
                                }
                                default -> QueryResult.ofValue(session, result.toString());
                        };

                        long endTime = System.currentTimeMillis();
                        callback.cost(endTime - startTime);

                        return ret;
                } catch (Exception e) {
                        throw new DriverException(e);
                }
        }

        @Override
        public DbType getType()
        {
                return DbType.redis;
        }

        @Override
        public List<DBNode> getNodeHierarchy()
        {
                List<DBNode> ret = Lists.newArrayList();
                RedisMetadataProvider metadataProvider = new RedisMetadataProvider(this);

                List<String> catalogs = getCatalogs();
                for (String catalog : catalogs)
                        ret.add(new RedisCatalogNode(catalog, metadataProvider));

                return ret;
        }

        @Override
        public DBNodePath getNodeHierarchyPath()
        {
                return new DBNodePath(DBNodeKind.CATALOG, null);
        }

        @Override
        protected Dialect createDialect()
        {
                return null;
        }

        @Override
        public String showCreateTable(Session session, String table)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public List<Suggestion> getSuggestions(Session session)
        {
                return Lists.newArrayList(RedisSuggestions.VALUES);
        }

        @Override
        public java.util.Map<String, List<Column>> getTableColumns(Session session)
        {
                /* Redis 非关系型，无表列概念 */
                return new java.util.HashMap<>();
        }

        @Override
        public List<Table> getTables(Session session)
        {
                return Lists.newArrayList();
        }

        @Override
        public List<Index> getIndexes(Session session, String table)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public Set<String> getIndexTypes()
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void dropTable(Session session, String table)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void dropColumns(Session session, String table, Collection<Column> columns)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void dropIndexKeys(Session session, String table, Collection<Index> selectionItems)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void dropPrimaryKey(Session session, String table)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void addPrimaryKey(Session session, String table, Collection<Column> primaryKeys)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void alterIndexKeys(Session session, String table, Collection<Index> indexes)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void alterChange(Session session, String table, Collection<Column> columns)
        {
                throw new UnsupportedOperationException();
        }

        @Override
        public void alterVisible(Session session, String table, Collection<Index> indexes)
        {
                throw new UnsupportedOperationException();
        }

}
