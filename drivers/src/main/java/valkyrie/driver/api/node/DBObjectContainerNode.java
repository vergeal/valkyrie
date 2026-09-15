package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.Session;
import valkyrie.driver.api.Table;
import valkyrie.utils.collection.Lists;

import java.util.ArrayList;
import java.util.List;

/**
 * 目录 / 模式下的通用对象容器（视图、触发器等），结构与 {@link DBTableContainerNode} 一致，
 * 只是装载的对象种类不同 —— 容器自身是 {@code kind}，列表项是 {@code itemKind}。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBObjectContainerNode extends DBNode
{
        private final ObjectLoader objectLoader;
        private final DBNodeKind itemKind;
        private final List<Table> objects = new ArrayList<>();
        private final @Getter Session session;

        public interface ObjectLoader {
                List<Table> load(Session session);
        }

        public DBObjectContainerNode(DBNode parent, String label, DBNodeKind kind, DBNodeKind itemKind, ObjectLoader objectLoader)
        {
                super(parent, label, kind, null);
                this.itemKind = itemKind;
                this.objectLoader = objectLoader;

                session = switch (parent) {
                        case DBCatalogNode catalogNode -> catalogNode.getSession();
                        case DBSchemaNode schemaNode -> schemaNode.getSession();
                        default -> throw new UnsupportedOperationException("DBObjectContainerNode 节点只允许挂载到目录或模式下");
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
                /* 与 DBTableContainerNode 同理：并发命中时必须在同一步里清空并填充 */
                List<Table> loaded = objectLoader.load(session);

                objects.clear();
                objects.addAll(loaded);

                List<DBNode> children = Lists.newArrayList();
                for (Table object : loaded)
                        children.add(new DBObjectNode(this, itemKind, object));

                return children;
        }

        public synchronized List<Table> getObjects()
        {
                return new ArrayList<>(objects);
        }
}
