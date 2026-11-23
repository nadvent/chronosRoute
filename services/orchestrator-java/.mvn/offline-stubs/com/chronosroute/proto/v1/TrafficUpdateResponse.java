package com.chronosroute.proto.v1;

public final class TrafficUpdateResponse {
    private final String batchId;
    private final boolean success;
    private final int edgesUpdated;
    private final long updateLatencyMicros;

    private TrafficUpdateResponse(Builder b) {
        this.batchId = b.batchId;
        this.success = b.success;
        this.edgesUpdated = b.edgesUpdated;
        this.updateLatencyMicros = b.updateLatencyMicros;
    }

    public String getBatchId() { return batchId; }
    public boolean getSuccess() { return success; }
    public int getEdgesUpdated() { return edgesUpdated; }
    public long getUpdateLatencyMicros() { return updateLatencyMicros; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String batchId = "";
        private boolean success;
        private int edgesUpdated;
        private long updateLatencyMicros;

        public Builder setBatchId(String batchId) { this.batchId = batchId; return this; }
        public Builder setSuccess(boolean success) { this.success = success; return this; }
        public Builder setEdgesUpdated(int edgesUpdated) { this.edgesUpdated = edgesUpdated; return this; }
        public Builder setUpdateLatencyMicros(long updateLatencyMicros) { this.updateLatencyMicros = updateLatencyMicros; return this; }
        public TrafficUpdateResponse build() { return new TrafficUpdateResponse(this); }
    }
}
