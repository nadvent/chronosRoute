package com.chronosroute.orchestrator.domain;

import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Delivery Order aggregate entity with deterministic state transitions and {@code @Version}
 * optimistic locking.
 */
public final class Order {
    private final UUID orderId;
    private final UUID hubId;
    private UUID courierId;
    private OrderStatus status;
    private final BigDecimal weightKg;
    private final GeoPoint pickupLocation;
    private final GeoPoint dropoffLocation;
    private final long dropoffNode;
    private final Instant windowStart;
    private final Instant windowEnd;
    private final int serviceDurationSeconds;
    private final Instant createdAt;
    private Instant updatedAt;

    @Version
    private int version;

    public Order(
            UUID orderId,
            UUID hubId,
            UUID courierId,
            OrderStatus status,
            BigDecimal weightKg,
            GeoPoint pickupLocation,
            GeoPoint dropoffLocation,
            long dropoffNode,
            Instant windowStart,
            Instant windowEnd,
            int serviceDurationSeconds,
            Instant createdAt,
            Instant updatedAt,
            int version) {
        this.orderId = Objects.requireNonNull(orderId, "orderId must not be null");
        this.hubId = Objects.requireNonNull(hubId, "hubId must not be null");
        this.courierId = courierId;
        this.status = Objects.requireNonNull(status, "status must not be null");
        this.weightKg = Objects.requireNonNull(weightKg, "weightKg must not be null");
        this.pickupLocation = Objects.requireNonNull(pickupLocation, "pickupLocation must not be null");
        this.dropoffLocation = Objects.requireNonNull(dropoffLocation, "dropoffLocation must not be null");
        this.dropoffNode = dropoffNode;
        this.windowStart = Objects.requireNonNull(windowStart, "windowStart must not be null");
        this.windowEnd = Objects.requireNonNull(windowEnd, "windowEnd must not be null");
        this.serviceDurationSeconds = serviceDurationSeconds;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt must not be null");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt must not be null");
        this.version = version;
    }

    public static Order createNew(
            UUID hubId,
            BigDecimal weightKg,
            GeoPoint pickupLocation,
            GeoPoint dropoffLocation,
            long dropoffNode,
            Instant windowStart,
            Instant windowEnd,
            int serviceDurationSeconds) {
        Instant now = Instant.now();
        return new Order(
                UUID.randomUUID(),
                hubId,
                null,
                OrderStatus.PENDING,
                weightKg,
                pickupLocation,
                dropoffLocation,
                dropoffNode,
                windowStart,
                windowEnd,
                serviceDurationSeconds,
                now,
                now,
                0);
    }

    public void transitionTo(OrderStatus nextStatus) {
        this.status = this.status.transitionTo(nextStatus);
        this.updatedAt = Instant.now();
    }

    public void assignToCourier(UUID assignedCourierId) {
        Objects.requireNonNull(assignedCourierId, "assignedCourierId must not be null");
        this.status = this.status.transitionTo(OrderStatus.ASSIGNED);
        this.courierId = assignedCourierId;
        this.updatedAt = Instant.now();
    }

    public void reassignCourier(UUID newCourierId) {
        Objects.requireNonNull(newCourierId, "newCourierId must not be null");
        if (this.status != OrderStatus.ASSIGNED) {
            throw new IllegalStateTransitionException(
                    "Only ASSIGNED orders can be reassigned without state transition (current="
                            + this.status + ")");
        }
        this.courierId = newCourierId;
        this.updatedAt = Instant.now();
    }

    public void releaseToPending() {
        this.status = this.status.transitionTo(OrderStatus.PENDING);
        this.courierId = null;
        this.updatedAt = Instant.now();
    }

    public void incrementVersion() {
        this.version++;
    }

    public Order copy() {
        return new Order(
                orderId,
                hubId,
                courierId,
                status,
                weightKg,
                pickupLocation,
                dropoffLocation,
                dropoffNode,
                windowStart,
                windowEnd,
                serviceDurationSeconds,
                createdAt,
                updatedAt,
                version);
    }

    public UUID getOrderId() { return orderId; }
    public UUID getHubId() { return hubId; }
    public UUID getCourierId() { return courierId; }
    public OrderStatus getStatus() { return status; }
    public BigDecimal getWeightKg() { return weightKg; }
    public GeoPoint getPickupLocation() { return pickupLocation; }
    public GeoPoint getDropoffLocation() { return dropoffLocation; }
    public long getDropoffNode() { return dropoffNode; }
    public Instant getWindowStart() { return windowStart; }
    public Instant getWindowEnd() { return windowEnd; }
    public int getServiceDurationSeconds() { return serviceDurationSeconds; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public int getVersion() { return version; }
}
