package valkyrie.driver.api.node;

import lombok.Getter;
import valkyrie.driver.api.Driver;
import valkyrie.driver.api.Session;
import valkyrie.driver.api.Table;
import valkyrie.utils.collection.Lists;

import java.util.List;

/**
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
@SuppressWarnings("ALL")
public class DBTableNode extends DBNode
{
        private final @Getter Table table;
        private final @Getter Driver driver;
        private final @Getter Session session;

        public DBTableNode(DBTableContainerNode parent, Table table)
        {
                super(parent, table.getName(), DBNodeKind.TABLE, null);
                this.table = table;
                this.driver = parent.getDriver();
                this.session = parent.getSession();
        }

        @Override
        public boolean hasChildren()
        {
                return true;
        }

        /**
         * 表下固定挂「字段 / 索引 / 外键」三类明细，展开时才真正去数据层读。
         */
        @Override
        public List<DBNode> getChildren()
        {
                String name = table.getName();

                return Lists.of(
                        new DBTableDetailNode(this, "字段", DBNodeKind.COLUMN, self ->
                                driver.getColumns(session, name).stream()
                                        .map(column -> (DBNode) new DBColumnNode(self, column))
                                        .toList()),
                        new DBTableDetailNode(this, "索引", DBNodeKind.INDEX, self ->
                                driver.getIndexes(session, name).stream()
                                        .map(index -> (DBNode) new DBIndexNode(self, index))
                                        .toList()),
                        new DBTableDetailNode(this, "外键", DBNodeKind.FOREIGN_KEY, self ->
                                driver.getForeignKeys(session, name).stream()
                                        .map(foreignKey -> (DBNode) new DBForeignKeyNode(self, foreignKey))
                                        .toList())
                );
        }
}
