package valkyrie.driver.api.node;

import java.util.List;

/**
 * 表下的明细分类节点（字段 / 索引 / 外键）：只做一层容器，展开时由外部的
 * {@link DetailLoader} 决定具体装载哪些叶子节点。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DBTableDetailNode extends DBNode
{
        private final DetailLoader detailLoader;

        public interface DetailLoader {
                List<DBNode> load(DBTableDetailNode self);
        }

        public DBTableDetailNode(DBNode parent, String label, DBNodeKind kind, DetailLoader detailLoader)
        {
                super(parent, label, kind, null);
                this.detailLoader = detailLoader;
        }

        @Override
        public boolean hasChildren()
        {
                return true;
        }

        @Override
        public List<DBNode> getChildren()
        {
                return detailLoader.load(this);
        }
}
