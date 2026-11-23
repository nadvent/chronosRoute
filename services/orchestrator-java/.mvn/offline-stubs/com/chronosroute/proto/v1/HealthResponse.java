package com.chronosroute.proto.v1;

public final class HealthResponse {
    private final boolean healthy;
    private final int activeWorkers;
    private final long totalSolvedRequests;
    private final double averageSolveDurationMs;
    private final long graphNodesCount;
    private final long graphEdgesCount;

    private HealthResponse(Builder b) {
        this.healthy = b.healthy;
        this.activeWorkers = b.activeWorkers;
        this.totalSolvedRequests = b.totalSolvedRequests;
        this.averageSolveDurationMs = b.averageSolveDurationMs;
        this.graphNodesCount = b.graphNodesCount;
        this.graphEdgesCount = b.graphEdgesCount;
    }

    public boolean getHealthy() { return healthy; }
    public int getActiveWorkers() { return activeWorkers; }
    public long getTotalSolvedRequests() { return totalSolvedRequests; }
    public double getAverageSolveDurationMs() { return averageSolveDurationMs; }
    public long getGraphNodesCount() { return graphNodesCount; }
    public long getGraphEdgesCount() { return graphEdgesCount; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private boolean healthy;
        private int activeWorkers;
        private long totalSolvedRequests;
        private double averageSolveDurationMs;
        private long graphNodesCount;
        private long graphEdgesCount;

        public Builder setHealthy(boolean healthy) { this.healthy = healthy; return this; }
        public Builder setActiveWorkers(int activeWorkers) { this.activeWorkers = activeWorkers; return this; }
        public Builder setTotalSolvedRequests(long totalSolvedRequests) { this.totalSolvedRequests = totalSolvedRequests; return this; }
        public Builder setAverageSolveDurationMs(double averageSolveDurationMs) { this.averageSolveDurationMs = averageSolveDurationMs; return this; }
        public Builder setGraphNodesCount(long graphNodesCount) { this.graphNodesCount = graphNodesCount; return this; }
        public Builder setGraphEdgesCount(long graphEdgesCount) { this.graphEdgesCount = graphEdgesCount; return this; }
        public HealthResponse build() { return new HealthResponse(this); }
    }
}
