package com.chronosroute.proto.v1;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class TrafficUpdateRequest {
    private final String batchId;
    private final long timestampUnix;
    private final List<EdgeSpeedMultiplier> edgeMultipliers;

    private TrafficUpdateRequest(Builder b) {
        this.batchId = b.batchId;
        this.timestampUnix = b.timestampUnix;
        this.edgeMultipliers = Collections.unmodifiableList(new ArrayList<>(b.edgeMultipliers));
    }

    public String getBatchId() { return batchId; }
    public long getTimestampUnix() { return timestampUnix; }
    public List<EdgeSpeedMultiplier> getEdgeMultipliersList() { return edgeMultipliers; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String batchId = "";
        private long timestampUnix;
        private final List<EdgeSpeedMultiplier> edgeMultipliers = new ArrayList<>();

        public Builder setBatchId(String batchId) { this.batchId = batchId; return this; }
        public Builder setTimestampUnix(long timestampUnix) { this.timestampUnix = timestampUnix; return this; }
        public Builder addEdgeMultipliers(EdgeSpeedMultiplier em) { this.edgeMultipliers.add(em); return this; }
        public TrafficUpdateRequest build() { return new TrafficUpdateRequest(this); }
    }
}
