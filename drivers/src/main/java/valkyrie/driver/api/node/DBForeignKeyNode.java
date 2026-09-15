package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.ForeignKey;

import java.util.List;

/**
 * 表外键叶子节点。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBForeignKeyNode extends DBNode
{
        private final @Getter ForeignKey foreignKey;

        public DBForeignKeyNode(DBNode parent, ForeignKey foreignKey)
        {
                super(parent, foreignKey.getName(), DBNodeKind.FOREIGN_KEY, null);
                this.foreignKey = foreignKey;
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
