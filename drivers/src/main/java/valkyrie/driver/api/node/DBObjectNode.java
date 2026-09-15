package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.Table;

import java.util.List;

/**
 * 通用数据库对象节点（视图、触发器等）：只有一层叶子，不再展开。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBObjectNode extends DBNode
{
        private final @Getter Table table;

        public DBObjectNode(DBNode parent, DBNodeKind kind, Table table)
        {
                super(parent, table.getName(), kind, null);
                this.table = table;
        }

        @Override
        public boolean hasChildren()
        {
                return false;
        }

        @Override
        public List<DBNode> getChildren()
        {
                return List.of();
        }
}
