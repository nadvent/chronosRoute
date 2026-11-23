package com.chronosroute.proto.v1;

public final class VehicleCapacity {
    private final String vehicleId;
    private final long maxWeightKg;
    private final long shiftStartUnix;
    private final long shiftEndUnix;
    private final GeoCoordinate startLocation;
    private final GeoCoordinate endLocation;
    private final int maxStops;

    private VehicleCapacity(Builder b) {
        this.vehicleId = b.vehicleId;
        this.maxWeightKg = b.maxWeightKg;
        this.shiftStartUnix = b.shiftStartUnix;
        this.shiftEndUnix = b.shiftEndUnix;
        this.startLocation = b.startLocation;
        this.endLocation = b.endLocation;
        this.maxStops = b.maxStops;
    }

    public String getVehicleId() { return vehicleId; }
    public long getMaxWeightKg() { return maxWeightKg; }
    public long getShiftStartUnix() { return shiftStartUnix; }
    public long getShiftEndUnix() { return shiftEndUnix; }
    public GeoCoordinate getStartLocation() { return startLocation; }
    public GeoCoordinate getEndLocation() { return endLocation; }
    public int getMaxStops() { return maxStops; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String vehicleId = "";
        private long maxWeightKg;
        private long shiftStartUnix;
        private long shiftEndUnix;
        private GeoCoordinate startLocation = GeoCoordinate.newBuilder().build();
        private GeoCoordinate endLocation = GeoCoordinate.newBuilder().build();
        private int maxStops;

        public Builder setVehicleId(String vehicleId) { this.vehicleId = vehicleId; return this; }
        public Builder setMaxWeightKg(long maxWeightKg) { this.maxWeightKg = maxWeightKg; return this; }
        public Builder setShiftStartUnix(long shiftStartUnix) { this.shiftStartUnix = shiftStartUnix; return this; }
        public Builder setShiftEndUnix(long shiftEndUnix) { this.shiftEndUnix = shiftEndUnix; return this; }
        public Builder setStartLocation(GeoCoordinate startLocation) { this.startLocation = startLocation; return this; }
        public Builder setEndLocation(GeoCoordinate endLocation) { this.endLocation = endLocation; return this; }
        public Builder setMaxStops(int maxStops) { this.maxStops = maxStops; return this; }

        public VehicleCapacity build() {
            return new VehicleCapacity(this);
        }
    }
}
