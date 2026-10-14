package valkyrie.core.model;

import lombok.Getter;
import lombok.Setter;

/**
 * @author Luo Tiansheng
 * @since 2026/4/13
 */
@Getter
@Setter
public class DiskSavedConnection
{
        private String name;
        /** 所属文件夹（对象导航里的归档分组）；空表示不在任何文件夹里 */
        private String group;
        private String type;
        private String sqlitePath;
        private String host;
        private String port;
        private String db;
        private String username;
        private String password;
        private Boolean savePassword = Boolean.FALSE;
        private String jdbcUrl;
        private String timezone;
        private Boolean useSSL = Boolean.FALSE;
        private Boolean tinyint1isBit = Boolean.FALSE;
}
