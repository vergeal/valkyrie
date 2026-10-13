package valkyrie.driver.api;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 一个库 / 模式下的主键与外键总览。
 * <p>
 * ER 图一次把整库的关系取回来，避免逐表读元数据（远端库上几百张表要几十秒）。
 *
 * @author Luo Tiansheng
 * @since 2026/10/13
 */
@Getter
@Setter
public class TableRelations
{
        /** 表名 → 主键字段（按主键定义顺序） */
        private Map<String, List<String>> primaryKeys = new LinkedHashMap<>();

        /** 表名 → 外键列表 */
        private Map<String, List<ForeignKey>> foreignKeys = new LinkedHashMap<>();

        public void addPrimaryKey(String table, String column)
        {
                primaryKeys.computeIfAbsent(table, key -> new ArrayList<>()).add(column);
        }

        /**
         * 按「一行一个字段」追加：同名的外键合并成一条（多字段外键按顺序累加）。
         */
        public ForeignKey addForeignKey(String table, String name, String column, String refTable, String refColumn,
                                        String refCatalog, String refSchema)
        {
                List<ForeignKey> keys = foreignKeys.computeIfAbsent(table, key -> new ArrayList<>());

                ForeignKey key = keys.stream()
                        .filter(item -> item.getName().equals(name))
                        .findFirst()
                        .orElseGet(() ->
                        {
                                ForeignKey created = new ForeignKey();
                                created.setName(name);
                                created.setColumns(new ArrayList<>());
                                created.setRefColumns(new ArrayList<>());
                                created.setRefTable(refTable);
                                created.setRefCatalog(refCatalog);
                                created.setRefSchema(refSchema);
                                keys.add(created);
                                return created;
                        });

                key.getColumns().add(column);
                key.getRefColumns().add(refColumn);

                return key;
        }

        /**
         * 直接追加一整条外键（JDBC 元数据路径用，字段已经成组）。
         */
        public ForeignKey addForeignKey(String table, ForeignKey source)
        {
                List<ForeignKey> keys = foreignKeys.computeIfAbsent(table, key -> new ArrayList<>());

                keys.add(source);

                return source;
        }
}
