package valkyrie.driver.postgresql;

import valkyrie.driver.api.Driver;
import valkyrie.driver.api.node.*;
import valkyrie.utils.collection.Lists;

import java.util.ArrayList;
import java.util.List;

/**
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
public class PostgresqlMetadataProvider implements DBMetadataProvider
{
        private final Driver driver;

        public PostgresqlMetadataProvider(Driver driver)
        {
                this.driver = driver;
        }

        @Override
        public List<DBNode> getChildrenOfCatalog(DBCatalogNode catalogNode)
        {
                List<DBNode> ret = new ArrayList<>();

                List<String> schemas = driver.getSchemas(catalogNode.getSession());
                for (String schema : schemas)
                        ret.add(new PostgresqlSchemaNode(catalogNode, schema, this));

                return ret;
        }

        @Override
        public List<DBNode> getChildrenOfSchema(DBSchemaNode schemaNode)
        {
                return Lists.of(
                        new DBTableContainerNode(schemaNode, driver),
                        new DBQueryContainerNode(schemaNode)
                );
        }
}
