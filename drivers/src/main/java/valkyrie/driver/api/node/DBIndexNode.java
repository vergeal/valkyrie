package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.Index;

import java.util.List;

/**
 * 表索引叶子节点。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBIndexNode extends DBNode
{
        private final @Getter Index index;

        public DBIndexNode(DBNode parent, Index index)
        {
                super(parent, index.getName(), DBNodeKind.INDEX, null);
                this.index = index;
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
