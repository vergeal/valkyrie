package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.Session;
import valkyrie.driver.api.Table;
import valkyrie.utils.collection.Lists;

import java.util.ArrayList;
import java.util.List;

/**
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBTableContainerNode extends DBNode
{
        private final TableLoader tableLoader;
        private final List<Table> tables = new ArrayList<>();
        private final @Getter Session session;

        public interface TableLoader {
                List<Table> load(Session session);
        }

        public DBTableContainerNode(DBNode parent, TableLoader tableLoader)
        {
                super(parent, "数据表", DBNodeKind.TABLE, null);
                this.tableLoader = tableLoader;

                session = switch (parent) {
                        case DBCatalogNode catalogNode -> catalogNode.getSession();
                        case DBSchemaNode schemaNode -> schemaNode.getSession();
                        default -> throw new UnsupportedOperationException("DBTableContainerNode 节点只允许挂载到目录或模式下");
                };
        }

        @Override
        public boolean hasChildren()
        {
                return true;
        }

        @Override
        public synchronized List<DBNode> getChildren()
        {
                /* schema.children 在服务端线程池里并发执行，同一个容器节点会被多条请求同时命中；
                   这里必须在同一步里清空并填充，否则交叉执行会让一份结果里出现重复的表节点 */
                List<Table> loaded = tableLoader.load(session);

                tables.clear();
                tables.addAll(loaded);

                List<DBNode> children = Lists.newArrayList();
                for (Table table : loaded)
                        children.add(new DBTableNode(this, table));

                return children;
        }

        public synchronized List<Table> getTables()
        {
                return new ArrayList<>(tables);
        }
}
