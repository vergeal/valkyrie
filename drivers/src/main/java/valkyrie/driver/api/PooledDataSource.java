package valkyrie.driver.api;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.logging.Logger;

/**
 * 带池化功能的连接池数据源对象
 *
 * @author Luo Tiansheng
 * @since 2026/3/27
 */
public class PooledDataSource
        implements VkDataSource
{
        private final HikariDataSource ds;

        private final ConnectionConfig conf;

        public PooledDataSource(ConnectionConfig conf)
        {
                this.conf = conf;

                HikariConfig hconf = new HikariConfig();

                hconf.setJdbcUrl(conf.getJdbcUrl());
                hconf.setUsername(conf.getUsername());
                hconf.setPassword(conf.getPassword());

                /*
                 * 连接池复用策略：
                 * - 常驻 1 条空闲连接，避免每次查询都重新握手；并发查询最多扩到 16 条；
                 * - 连接最多活 30 分钟、空闲 10 分钟回收，2 分钟探活一次 ——
                 *   防止被数据库端 wait_timeout 悄悄断掉的连接还留在池里被复用到。
                 */
                hconf.setPoolName("valkyrie-" + conf.getType().name().toLowerCase() + "-" + Integer.toHexString(String.valueOf(conf.getJdbcUrl()).hashCode()));
                hconf.setMaximumPoolSize(16);
                hconf.setMinimumIdle(1);
                hconf.setConnectionTimeout(30000);
                hconf.setIdleTimeout(600000);
                hconf.setMaxLifetime(1800000);
                hconf.setKeepaliveTime(120000);
                hconf.setValidationTimeout(5000);

                String driverClass = conf.getType().getDriverClass();

                if (driverClass != null)
                        hconf.setDriverClassName(driverClass);

                ds = new HikariDataSource(hconf);
        }

        /* ******************************************************************************** */
        /*                            DATASOURCE PROXY IMPLEMENTS                           */
        /* ******************************************************************************** */

        @Override
        public ConnectionConfig getConnectionConfig()
        {
                return conf;
        }

        @Override
        public Connection getConnection() throws SQLException
        {
                return ds.getConnection();
        }

        @Override
        public Connection getConnection(String username, String password) throws SQLException
        {
                return ds.getConnection();
        }

        @Override
        public PrintWriter getLogWriter() throws SQLException
        {
                return ds.getLogWriter();
        }

        @Override
        public void setLogWriter(PrintWriter out) throws SQLException
        {
                ds.setLogWriter(out);
        }

        @Override
        public void setLoginTimeout(int seconds) throws SQLException
        {
                ds.setLoginTimeout(seconds);
        }

        @Override
        public int getLoginTimeout() throws SQLException
        {
                return ds.getLoginTimeout();
        }

        @Override
        public <T> T unwrap(Class<T> iface) throws SQLException
        {
                return ds.unwrap(iface);
        }

        @Override
        public boolean isWrapperFor(Class<?> iface) throws SQLException
        {
                return ds.isWrapperFor(iface);
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException
        {
                return ds.getParentLogger();
        }

        @Override
        public void close() throws Exception
        {
                ds.close();
        }
}
