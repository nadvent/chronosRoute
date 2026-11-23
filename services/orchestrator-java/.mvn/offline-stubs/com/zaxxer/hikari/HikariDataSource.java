package com.zaxxer.hikari;

import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.logging.Logger;
import javax.sql.DataSource;

public class HikariDataSource implements DataSource {
    public HikariPoolMXBean getHikariPoolMXBean() { return null; }
    public int getMaximumPoolSize() { return 32; }
    @Override public Connection getConnection() throws SQLException { throw new SQLException("stub"); }
    @Override public Connection getConnection(String u, String p) throws SQLException { throw new SQLException("stub"); }
    @Override public PrintWriter getLogWriter() { return null; }
    @Override public void setLogWriter(PrintWriter out) {}
    @Override public void setLoginTimeout(int seconds) {}
    @Override public int getLoginTimeout() { return 0; }
    @Override public Logger getParentLogger() { return Logger.getGlobal(); }
    @Override public <T> T unwrap(Class<T> iface) throws SQLException { throw new SQLException("stub"); }
    @Override public boolean isWrapperFor(Class<?> iface) { return false; }
}
