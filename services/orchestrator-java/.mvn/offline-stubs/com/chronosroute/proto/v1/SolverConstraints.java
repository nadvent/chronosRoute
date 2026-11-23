package com.chronosroute.proto.v1;

public final class SolverConstraints {
    private final long deadlineMs;
    private final int numSearchTrajectories;
    private final double latePenaltyPerSecond;
    private final boolean allowUnassignedStops;

    private SolverConstraints(Builder b) {
        this.deadlineMs = b.deadlineMs;
        this.numSearchTrajectories = b.numSearchTrajectories;
        this.latePenaltyPerSecond = b.latePenaltyPerSecond;
        this.allowUnassignedStops = b.allowUnassignedStops;
    }

    public long getDeadlineMs() { return deadlineMs; }
    public int getNumSearchTrajectories() { return numSearchTrajectories; }
    public double getLatePenaltyPerSecond() { return latePenaltyPerSecond; }
    public boolean getAllowUnassignedStops() { return allowUnassignedStops; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private long deadlineMs = 500;
        private int numSearchTrajectories = 4;
        private double latePenaltyPerSecond = 10.0;
        private boolean allowUnassignedStops = true;

        public Builder setDeadlineMs(long deadlineMs) { this.deadlineMs = deadlineMs; return this; }
        public Builder setNumSearchTrajectories(int numSearchTrajectories) { this.numSearchTrajectories = numSearchTrajectories; return this; }
        public Builder setLatePenaltyPerSecond(double latePenaltyPerSecond) { this.latePenaltyPerSecond = latePenaltyPerSecond; return this; }
        public Builder setAllowUnassignedStops(boolean allowUnassignedStops) { this.allowUnassignedStops = allowUnassignedStops; return this; }

        public SolverConstraints build() {
            return new SolverConstraints(this);
        }
    }
}
