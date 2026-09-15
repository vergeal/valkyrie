package valkyrie.driver.dm;

import valkyrie.driver.api.Driver;
import valkyrie.driver.api.node.*;
import valkyrie.utils.collection.Lists;

import java.util.List;

/**
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class DMMetadataProvider implements DBMetadataProvider
{
        private final Driver driver;

        public DMMetadataProvider(Driver driver)
        {
                this.driver = driver;
        }

        @Override
        public List<DBNode> getChildrenOfCatalog(DBCatalogNode catalogNode)
        {
                throw new UnsupportedOperationException("达梦数据库不支持获取数据库(Catalog)列表");
        }

        @Override
        public List<DBNode> getChildrenOfSchema(DBSchemaNode schemaNode)
        {
                return Lists.of(
                        new DBTableContainerNode(schemaNode, driver),
                        new DBQueryContainerNode(schemaNode));
        }
}
