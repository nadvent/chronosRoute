package com.chronosroute.proto.v1;

public final class EdgeSpeedMultiplier {
    private final long edgeId;
    private final float speedMultiplier;

    private EdgeSpeedMultiplier(Builder b) {
        this.edgeId = b.edgeId;
        this.speedMultiplier = b.speedMultiplier;
    }

    public long getEdgeId() { return edgeId; }
    public float getSpeedMultiplier() { return speedMultiplier; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private long edgeId;
        private float speedMultiplier;

        public Builder setEdgeId(long edgeId) { this.edgeId = edgeId; return this; }
        public Builder setSpeedMultiplier(float speedMultiplier) { this.speedMultiplier = speedMultiplier; return this; }
        public EdgeSpeedMultiplier build() { return new EdgeSpeedMultiplier(this); }
    }
}
