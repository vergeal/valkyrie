package valkyrie.driver.mysql;

import valkyrie.driver.api.Driver;
import valkyrie.driver.api.node.*;
import valkyrie.utils.collection.Lists;

import java.util.List;

/**
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class MySQLMetadataProvider implements DBMetadataProvider
{
        private final Driver driver;

        public MySQLMetadataProvider(Driver driver)
        {
                this.driver = driver;
        }

        @Override
        public List<DBNode> getChildrenOfCatalog(DBCatalogNode catalogNode)
        {
                return Lists.of(
                        new DBTableContainerNode(catalogNode, driver),
                        new DBObjectContainerNode(catalogNode, "视图", DBNodeKind.VIEW, DBNodeKind.VIEW, driver::getViews),
                        new DBObjectContainerNode(catalogNode, "触发器", DBNodeKind.TRIGGER, DBNodeKind.TRIGGER, driver::getTriggers),
                        new DBQueryContainerNode(catalogNode)
                );
        }

        @Override
        public List<DBNode> getChildrenOfSchema(DBSchemaNode schemaNode)
        {
                throw new UnsupportedOperationException("MySQL 数据库不支持获取模式(Schema)列表");
        }
}
