package com.chronosroute.proto.v1;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class CVRPTWRequest {
    private final String requestId;
    private final List<VehicleCapacity> vehicles;
    private final List<DeliveryStop> stops;
    private final SolverConstraints constraints;

    private CVRPTWRequest(Builder b) {
        this.requestId = b.requestId;
        this.vehicles = Collections.unmodifiableList(new ArrayList<>(b.vehicles));
        this.stops = Collections.unmodifiableList(new ArrayList<>(b.stops));
        this.constraints = b.constraints;
    }

    public String getRequestId() { return requestId; }
    public List<VehicleCapacity> getVehiclesList() { return vehicles; }
    public List<DeliveryStop> getStopsList() { return stops; }
    public SolverConstraints getConstraints() { return constraints; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String requestId = "";
        private final List<VehicleCapacity> vehicles = new ArrayList<>();
        private final List<DeliveryStop> stops = new ArrayList<>();
        private SolverConstraints constraints = SolverConstraints.newBuilder().build();

        public Builder setRequestId(String requestId) { this.requestId = requestId; return this; }
        public Builder addVehicles(VehicleCapacity vehicle) { this.vehicles.add(vehicle); return this; }
        public Builder addAllVehicles(Iterable<VehicleCapacity> vehicles) {
            for (VehicleCapacity v : vehicles) { this.vehicles.add(v); }
            return this;
        }
        public Builder addStops(DeliveryStop stop) { this.stops.add(stop); return this; }
        public Builder addAllStops(Iterable<DeliveryStop> stops) {
            for (DeliveryStop s : stops) { this.stops.add(s); }
            return this;
        }
        public Builder setConstraints(SolverConstraints constraints) { this.constraints = constraints; return this; }

        public CVRPTWRequest build() {
            return new CVRPTWRequest(this);
        }
    }
}
