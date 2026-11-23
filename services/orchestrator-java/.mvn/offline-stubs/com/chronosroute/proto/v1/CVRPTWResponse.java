package com.chronosroute.proto.v1;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class CVRPTWResponse {
    private final String requestId;
    private final SolverStatus status;
    private final List<VehicleRoute> routes;
    private final List<String> unassignedStopIds;
    private final double objectiveCost;
    private final long solverDurationMs;
    private final int iterationsCompleted;
    private final String errorMessage;

    private CVRPTWResponse(Builder b) {
        this.requestId = b.requestId;
        this.status = b.status;
        this.routes = Collections.unmodifiableList(new ArrayList<>(b.routes));
        this.unassignedStopIds = Collections.unmodifiableList(new ArrayList<>(b.unassignedStopIds));
        this.objectiveCost = b.objectiveCost;
        this.solverDurationMs = b.solverDurationMs;
        this.iterationsCompleted = b.iterationsCompleted;
        this.errorMessage = b.errorMessage;
    }

    public String getRequestId() { return requestId; }
    public SolverStatus getStatus() { return status; }
    public List<VehicleRoute> getRoutesList() { return routes; }
    public List<String> getUnassignedStopIdsList() { return unassignedStopIds; }
    public double getObjectiveCost() { return objectiveCost; }
    public long getSolverDurationMs() { return solverDurationMs; }
    public int getIterationsCompleted() { return iterationsCompleted; }
    public String getErrorMessage() { return errorMessage; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String requestId = "";
        private SolverStatus status = SolverStatus.SOLVER_STATUS_OPTIMAL;
        private final List<VehicleRoute> routes = new ArrayList<>();
        private final List<String> unassignedStopIds = new ArrayList<>();
        private double objectiveCost;
        private long solverDurationMs;
        private int iterationsCompleted;
        private String errorMessage = "";

        public Builder setRequestId(String requestId) { this.requestId = requestId; return this; }
        public Builder setStatus(SolverStatus status) { this.status = status; return this; }
        public Builder addRoutes(VehicleRoute route) { this.routes.add(route); return this; }
        public Builder addAllRoutes(Iterable<VehicleRoute> routes) {
            for (VehicleRoute r : routes) { this.routes.add(r); }
            return this;
        }
        public Builder addUnassignedStopIds(String stopId) { this.unassignedStopIds.add(stopId); return this; }
        public Builder addAllUnassignedStopIds(Iterable<String> stopIds) {
            for (String s : stopIds) { this.unassignedStopIds.add(s); }
            return this;
        }
        public Builder setObjectiveCost(double objectiveCost) { this.objectiveCost = objectiveCost; return this; }
        public Builder setSolverDurationMs(long solverDurationMs) { this.solverDurationMs = solverDurationMs; return this; }
        public Builder setIterationsCompleted(int iterationsCompleted) { this.iterationsCompleted = iterationsCompleted; return this; }
        public Builder setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; return this; }

        public CVRPTWResponse build() {
            return new CVRPTWResponse(this);
        }
    }
}
