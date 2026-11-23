package com.chronosroute.proto.v1;

public final class GeoCoordinate {
    private final double latitude;
    private final double longitude;

    private GeoCoordinate(double latitude, double longitude) {
        this.latitude = latitude;
        this.longitude = longitude;
    }

    public double getLatitude() {
        return latitude;
    }

    public double getLongitude() {
        return longitude;
    }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private double latitude;
        private double longitude;

        public Builder setLatitude(double latitude) {
            this.latitude = latitude;
            return this;
        }

        public Builder setLongitude(double longitude) {
            this.longitude = longitude;
            return this;
        }

        public GeoCoordinate build() {
            return new GeoCoordinate(latitude, longitude);
        }
    }
}
