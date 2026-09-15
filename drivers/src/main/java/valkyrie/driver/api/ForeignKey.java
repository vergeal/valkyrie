package valkyrie.driver.api;

import lombok.Getter;
import lombok.Setter;

import java.util.List;

/**
 * 外键元数据：一条外键约束（可能由多个字段组成）。
 *
 * @author Luo Tiansheng
 * @since 2026/6/5
 */
@Getter
@Setter
public class ForeignKey
{
        /**
         * 外键约束名
         */
        private String name;

        /**
         * 本表参与外键的字段
         */
        private List<String> columns;

        /**
         * 引用的表名
         */
        private String refTable;

        /**
         * 引用表被引用的字段
         */
        private List<String> refColumns;

        /**
         * 本表字段文本（展示用，如 {@code `a`, `b`}）
         */
        public String getColumnsText()
        {
                return columns == null ? "" : String.join(", ", columns);
        }

        /**
         * 被引用字段文本（展示用）
         */
        public String getRefColumnsText()
        {
                return refColumns == null ? "" : String.join(", ", refColumns);
        }
}
