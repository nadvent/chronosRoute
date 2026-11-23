package com.chronosroute.proto.v1;

public final class DeliveryStop {
    private final String stopId;
    private final GeoCoordinate coordinate;
    private final long demandKg;
    private final long windowStartUnix;
    private final long windowEndUnix;
    private final long serviceDurationSeconds;
    private final StopType stopType;
    private final String pairedStopId;
    private final int priority;

    private DeliveryStop(Builder b) {
        this.stopId = b.stopId;
        this.coordinate = b.coordinate;
        this.demandKg = b.demandKg;
        this.windowStartUnix = b.windowStartUnix;
        this.windowEndUnix = b.windowEndUnix;
        this.serviceDurationSeconds = b.serviceDurationSeconds;
        this.stopType = b.stopType;
        this.pairedStopId = b.pairedStopId;
        this.priority = b.priority;
    }

    public String getStopId() { return stopId; }
    public GeoCoordinate getCoordinate() { return coordinate; }
    public long getDemandKg() { return demandKg; }
    public long getWindowStartUnix() { return windowStartUnix; }
    public long getWindowEndUnix() { return windowEndUnix; }
    public long getServiceDurationSeconds() { return serviceDurationSeconds; }
    public StopType getStopType() { return stopType; }
    public String getPairedStopId() { return pairedStopId; }
    public int getPriority() { return priority; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String stopId = "";
        private GeoCoordinate coordinate = GeoCoordinate.newBuilder().build();
        private long demandKg;
        private long windowStartUnix;
        private long windowEndUnix;
        private long serviceDurationSeconds;
        private StopType stopType = StopType.STOP_TYPE_UNSPECIFIED;
        private String pairedStopId = "";
        private int priority;

        public Builder setStopId(String stopId) { this.stopId = stopId; return this; }
        public Builder setCoordinate(GeoCoordinate coordinate) { this.coordinate = coordinate; return this; }
        public Builder setDemandKg(long demandKg) { this.demandKg = demandKg; return this; }
        public Builder setWindowStartUnix(long windowStartUnix) { this.windowStartUnix = windowStartUnix; return this; }
        public Builder setWindowEndUnix(long windowEndUnix) { this.windowEndUnix = windowEndUnix; return this; }
        public Builder setServiceDurationSeconds(long serviceDurationSeconds) { this.serviceDurationSeconds = serviceDurationSeconds; return this; }
        public Builder setStopType(StopType stopType) { this.stopType = stopType; return this; }
        public Builder setPairedStopId(String pairedStopId) { this.pairedStopId = pairedStopId; return this; }
        public Builder setPriority(int priority) { this.priority = priority; return this; }

        public DeliveryStop build() {
            return new DeliveryStop(this);
        }
    }
}
