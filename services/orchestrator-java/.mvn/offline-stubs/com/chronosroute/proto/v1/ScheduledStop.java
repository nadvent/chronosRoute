package com.chronosroute.proto.v1;

public final class ScheduledStop {
    private final String stopId;
    private final long estimatedArrivalUnix;
    private final long estimatedDepartureUnix;
    private final long slackSeconds;
    private final long accumulatedLoadKg;

    private ScheduledStop(Builder b) {
        this.stopId = b.stopId;
        this.estimatedArrivalUnix = b.estimatedArrivalUnix;
        this.estimatedDepartureUnix = b.estimatedDepartureUnix;
        this.slackSeconds = b.slackSeconds;
        this.accumulatedLoadKg = b.accumulatedLoadKg;
    }

    public String getStopId() { return stopId; }
    public long getEstimatedArrivalUnix() { return estimatedArrivalUnix; }
    public long getEstimatedDepartureUnix() { return estimatedDepartureUnix; }
    public long getSlackSeconds() { return slackSeconds; }
    public long getAccumulatedLoadKg() { return accumulatedLoadKg; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String stopId = "";
        private long estimatedArrivalUnix;
        private long estimatedDepartureUnix;
        private long slackSeconds;
        private long accumulatedLoadKg;

        public Builder setStopId(String stopId) { this.stopId = stopId; return this; }
        public Builder setEstimatedArrivalUnix(long estimatedArrivalUnix) { this.estimatedArrivalUnix = estimatedArrivalUnix; return this; }
        public Builder setEstimatedDepartureUnix(long estimatedDepartureUnix) { this.estimatedDepartureUnix = estimatedDepartureUnix; return this; }
        public Builder setSlackSeconds(long slackSeconds) { this.slackSeconds = slackSeconds; return this; }
        public Builder setAccumulatedLoadKg(long accumulatedLoadKg) { this.accumulatedLoadKg = accumulatedLoadKg; return this; }

        public ScheduledStop build() {
            return new ScheduledStop(this);
        }
    }
}
