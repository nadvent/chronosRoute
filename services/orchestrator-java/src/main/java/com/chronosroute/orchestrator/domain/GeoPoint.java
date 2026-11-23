package com.chronosroute.orchestrator.domain;

import java.util.Locale;

/**
 * Immutable WGS84 (SRID 4326) spatial coordinate value object.
 */
public record GeoPoint(double latitude, double longitude) {
    public GeoPoint {
        if (Double.isNaN(latitude) || latitude < -90.0 || latitude > 90.0) {
            throw new IllegalArgumentException("Latitude out of WGS84 bounds [-90, 90]: " + latitude);
        }
        if (Double.isNaN(longitude) || longitude < -180.0 || longitude > 180.0) {
            throw new IllegalArgumentException("Longitude out of WGS84 bounds [-180, 180]: " + longitude);
        }
    }

    public String toWkt() {
        return String.format(Locale.ROOT, "POINT(%.6f %.6f)", longitude, latitude);
    }

    public double haversineMetersTo(GeoPoint other) {
        final double earthRadiusMeters = 6_371_000.0;
        double dLat = Math.toRadians(other.latitude - this.latitude);
        double dLon = Math.toRadians(other.longitude - this.longitude);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(this.latitude))
                        * Math.cos(Math.toRadians(other.latitude))
                        * Math.sin(dLon / 2)
                        * Math.sin(dLon / 2);
        double c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
        return earthRadiusMeters * c;
    }
}
