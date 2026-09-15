package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.Column;

import java.util.List;

/**
 * 表字段叶子节点。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBColumnNode extends DBNode
{
        private final @Getter Column column;

        public DBColumnNode(DBNode parent, Column column)
        {
                super(parent, column.getName(), DBNodeKind.COLUMN, null);
                this.column = column;
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
