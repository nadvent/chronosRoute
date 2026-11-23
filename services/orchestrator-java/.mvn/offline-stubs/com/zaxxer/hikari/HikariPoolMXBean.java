package com.zaxxer.hikari;

public interface HikariPoolMXBean {
    int getActiveConnections();
    int getIdleConnections();
    int getTotalConnections();
    int getThreadsAwaitingConnection();
}
