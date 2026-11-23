package com.chronosroute.proto.v1;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class VehicleRoute {
    private final String vehicleId;
    private final List<ScheduledStop> scheduledStops;
    private final long totalDistanceMeters;
    private final long totalDurationSeconds;
    private final long totalWaitSeconds;
    private final long totalPenaltyCost;
    private final String encodedPolyline;

    private VehicleRoute(Builder b) {
        this.vehicleId = b.vehicleId;
        this.scheduledStops = Collections.unmodifiableList(new ArrayList<>(b.scheduledStops));
        this.totalDistanceMeters = b.totalDistanceMeters;
        this.totalDurationSeconds = b.totalDurationSeconds;
        this.totalWaitSeconds = b.totalWaitSeconds;
        this.totalPenaltyCost = b.totalPenaltyCost;
        this.encodedPolyline = b.encodedPolyline;
    }

    public String getVehicleId() { return vehicleId; }
    public List<ScheduledStop> getScheduledStopsList() { return scheduledStops; }
    public long getTotalDistanceMeters() { return totalDistanceMeters; }
    public long getTotalDurationSeconds() { return totalDurationSeconds; }
    public long getTotalWaitSeconds() { return totalWaitSeconds; }
    public long getTotalPenaltyCost() { return totalPenaltyCost; }
    public String getEncodedPolyline() { return encodedPolyline; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String vehicleId = "";
        private final List<ScheduledStop> scheduledStops = new ArrayList<>();
        private long totalDistanceMeters;
        private long totalDurationSeconds;
        private long totalWaitSeconds;
        private long totalPenaltyCost;
        private String encodedPolyline = "";

        public Builder setVehicleId(String vehicleId) { this.vehicleId = vehicleId; return this; }
        public Builder addScheduledStops(ScheduledStop stop) { this.scheduledStops.add(stop); return this; }
        public Builder addAllScheduledStops(Iterable<ScheduledStop> stops) {
            for (ScheduledStop s : stops) { this.scheduledStops.add(s); }
            return this;
        }
        public Builder setTotalDistanceMeters(long totalDistanceMeters) { this.totalDistanceMeters = totalDistanceMeters; return this; }
        public Builder setTotalDurationSeconds(long totalDurationSeconds) { this.totalDurationSeconds = totalDurationSeconds; return this; }
        public Builder setTotalWaitSeconds(long totalWaitSeconds) { this.totalWaitSeconds = totalWaitSeconds; return this; }
        public Builder setTotalPenaltyCost(long totalPenaltyCost) { this.totalPenaltyCost = totalPenaltyCost; return this; }
        public Builder setEncodedPolyline(String encodedPolyline) { this.encodedPolyline = encodedPolyline; return this; }

        public VehicleRoute build() {
            return new VehicleRoute(this);
        }
    }
}
