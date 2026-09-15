package valkyrie.driver.sqlite;

import valkyrie.driver.api.Driver;
import valkyrie.driver.api.node.*;
import valkyrie.utils.collection.Lists;

import java.util.List;

/**
 * @author Luo Tiansheng
 * @since 2026/6/9
 */
public class SQLiteMetadataProvider implements DBMetadataProvider
{
        private final Driver driver;

        public SQLiteMetadataProvider(Driver driver)
        {
                this.driver = driver;
        }

        @Override
        public List<DBNode> getChildrenOfCatalog(DBCatalogNode catalogNode)
        {
                return Lists.of(
                        new DBTableContainerNode(catalogNode, driver),
                        new DBQueryContainerNode(catalogNode)
                );
        }

        @Override
        public List<DBNode> getChildrenOfSchema(DBSchemaNode schemaNode)
        {
                return List.of();
        }
}
