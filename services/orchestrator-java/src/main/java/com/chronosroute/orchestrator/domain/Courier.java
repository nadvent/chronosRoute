package com.chronosroute.orchestrator.domain;

import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * Courier domain entity with shift bounds, spatial location, retained route state,
 * and {@code @Version} optimistic locking.
 */
public final class Courier {
    private final UUID courierId;
    private final String name;
    private CourierStatus status;
    private BigDecimal currentCapacityKg;
    private final BigDecimal maxCapacityKg;
    private GeoPoint lastLocation;
    private Instant lastPingAt;
    private final Instant shiftStart;
    private final Instant shiftEnd;
    private final Instant createdAt;
    private List<UUID> activeRouteOrderIds;
    private String activeEncodedPolyline;

    @Version
    private int version;

    public Courier(
            UUID courierId,
            String name,
            CourierStatus status,
            BigDecimal currentCapacityKg,
            BigDecimal maxCapacityKg,
            GeoPoint lastLocation,
            Instant lastPingAt,
            Instant shiftStart,
            Instant shiftEnd,
            Instant createdAt,
            int version) {
        this(
                courierId,
                name,
                status,
                currentCapacityKg,
                maxCapacityKg,
                lastLocation,
                lastPingAt,
                shiftStart,
                shiftEnd,
                createdAt,
                version,
                List.of(),
                "");
    }

    public Courier(
            UUID courierId,
            String name,
            CourierStatus status,
            BigDecimal currentCapacityKg,
            BigDecimal maxCapacityKg,
            GeoPoint lastLocation,
            Instant lastPingAt,
            Instant shiftStart,
            Instant shiftEnd,
            Instant createdAt,
            int version,
            List<UUID> activeRouteOrderIds,
            String activeEncodedPolyline) {
        this.courierId = Objects.requireNonNull(courierId, "courierId must not be null");
        this.name = Objects.requireNonNull(name, "name must not be null");
        this.status = Objects.requireNonNull(status, "status must not be null");
        this.currentCapacityKg = Objects.requireNonNull(currentCapacityKg, "currentCapacityKg must not be null");
        this.maxCapacityKg = Objects.requireNonNull(maxCapacityKg, "maxCapacityKg must not be null");
        this.lastLocation = Objects.requireNonNull(lastLocation, "lastLocation must not be null");
        this.lastPingAt = Objects.requireNonNull(lastPingAt, "lastPingAt must not be null");
        this.shiftStart = Objects.requireNonNull(shiftStart, "shiftStart must not be null");
        this.shiftEnd = Objects.requireNonNull(shiftEnd, "shiftEnd must not be null");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt must not be null");
        this.version = version;
        this.activeRouteOrderIds = Collections.unmodifiableList(new ArrayList<>(activeRouteOrderIds));
        this.activeEncodedPolyline = activeEncodedPolyline == null ? "" : activeEncodedPolyline;
    }

    public void assignRoute(List<UUID> orderIds, BigDecimal totalAddedWeightKg, String encodedPolyline) {
        if (currentCapacityKg.compareTo(totalAddedWeightKg) < 0) {
            throw new IllegalArgumentException(
                    "Insufficient capacity on courier " + courierId + ": available="
                            + currentCapacityKg + ", required=" + totalAddedWeightKg);
        }
        this.currentCapacityKg = this.currentCapacityKg.subtract(totalAddedWeightKg);
        if (this.status == CourierStatus.IDLE) {
            this.status = this.status.transitionTo(CourierStatus.ASSIGNED);
        }
        List<UUID> merged = new ArrayList<>(this.activeRouteOrderIds);
        merged.addAll(orderIds);
        this.activeRouteOrderIds = Collections.unmodifiableList(merged);
        if (encodedPolyline != null && !encodedPolyline.isBlank()) {
            this.activeEncodedPolyline = encodedPolyline;
        }
    }

    public void replaceRoute(List<UUID> orderIds, BigDecimal totalRouteWeightKg, String encodedPolyline) {
        Objects.requireNonNull(orderIds, "orderIds must not be null");
        Objects.requireNonNull(totalRouteWeightKg, "totalRouteWeightKg must not be null");
        if (maxCapacityKg.compareTo(totalRouteWeightKg) < 0) {
            throw new IllegalArgumentException(
                    "Insufficient max capacity on courier " + courierId + ": max="
                            + maxCapacityKg + ", required=" + totalRouteWeightKg);
        }
        this.currentCapacityKg = this.maxCapacityKg.subtract(totalRouteWeightKg);
        if (orderIds.isEmpty()) {
            if (this.status == CourierStatus.ASSIGNED) {
                this.status = this.status.transitionTo(CourierStatus.IDLE);
            }
            this.activeRouteOrderIds = List.of();
            this.activeEncodedPolyline = "";
        } else {
            if (this.status == CourierStatus.IDLE) {
                this.status = this.status.transitionTo(CourierStatus.ASSIGNED);
            }
            this.activeRouteOrderIds = Collections.unmodifiableList(new ArrayList<>(orderIds));
            this.activeEncodedPolyline = encodedPolyline == null ? "" : encodedPolyline;
        }
    }

    public void updateTelemetry(GeoPoint newLocation, Instant pingTime) {
        this.lastLocation = Objects.requireNonNull(newLocation, "newLocation must not be null");
        this.lastPingAt = Objects.requireNonNull(pingTime, "pingTime must not be null");
    }

    public void incrementVersion() {
        this.version++;
    }

    public Courier copy() {
        return new Courier(
                courierId,
                name,
                status,
                currentCapacityKg,
                maxCapacityKg,
                lastLocation,
                lastPingAt,
                shiftStart,
                shiftEnd,
                createdAt,
                version,
                activeRouteOrderIds,
                activeEncodedPolyline);
    }

    public UUID getCourierId() { return courierId; }
    public String getName() { return name; }
    public CourierStatus getStatus() { return status; }
    public BigDecimal getCurrentCapacityKg() { return currentCapacityKg; }
    public BigDecimal getMaxCapacityKg() { return maxCapacityKg; }
    public GeoPoint getLastLocation() { return lastLocation; }
    public Instant getLastPingAt() { return lastPingAt; }
    public Instant getShiftStart() { return shiftStart; }
    public Instant getShiftEnd() { return shiftEnd; }
    public Instant getCreatedAt() { return createdAt; }
    public List<UUID> getActiveRouteOrderIds() { return activeRouteOrderIds; }
    public String getActiveEncodedPolyline() { return activeEncodedPolyline; }
    public int getVersion() { return version; }
}
