package valkyrie.driver.api;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.ToString;

import java.util.Date;

/**
 * 数据库表元数据记录。
 * <p>
 * 该 record 表示数据库中的一张基本表（TABLE）的摘要信息，包含表名、存储引擎、估算大小、
 * 行数、注释等元数据。所有字段均为不可变（immutable）且可直接通过访问器方法获取。
 * <p>
 * 典型使用场景：
 * <ul>
 *   <li>从 {@link java.sql.DatabaseMetaData#getTables} 结果集中提取表基本信息</li>
 *   <li>作为数据字典或 Schema 浏览模块的返回值类型</li>
 *   <li>在数据库管理工具中展示表的统计信息</li>
 * </ul>
 *
 * @author Luo Tiansheng
 * @since 2026/4/11
 */
@Data
@ToString
@AllArgsConstructor
@NoArgsConstructor
public class Table
{
        /**
         * 数据库名字
         */
        private String name;

        /**
         * 创建时间
         */
        private Date createTime;

        /**
         * 修改时间
         */
        private Date updateTime;

        /**
         * 存储引擎
         */
        private String engine;

        /**
         * 数据大小（字节）
         */
        private Float size;

        /**
         * 数据行数
         */
        private Integer rows;

        /**
         * 表注释
         */
        private String comment;

        public Table(String name) { this.name = name; }
}
