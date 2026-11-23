package com.chronosroute.orchestrator.domain;

import jakarta.persistence.Version;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Transactional Outbox event persisted atomically alongside order/courier state changes.
 */
public final class OutboxEvent {
    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_PUBLISHED = "PUBLISHED";
    public static final String STATUS_FAILED = "FAILED";

    private final UUID eventId;
    private final String aggregateType;
    private final String aggregateId;
    private final String eventType;
    private final String payload;
    private String status;
    private int retryCount;
    private final Instant createdAt;
    private Instant publishedAt;

    @Version
    private int version;

    public OutboxEvent(
            UUID eventId,
            String aggregateType,
            String aggregateId,
            String eventType,
            String payload,
            String status,
            int retryCount,
            Instant createdAt,
            Instant publishedAt,
            int version) {
        this.eventId = Objects.requireNonNull(eventId, "eventId must not be null");
        this.aggregateType = Objects.requireNonNull(aggregateType, "aggregateType must not be null");
        this.aggregateId = Objects.requireNonNull(aggregateId, "aggregateId must not be null");
        this.eventType = Objects.requireNonNull(eventType, "eventType must not be null");
        this.payload = Objects.requireNonNull(payload, "payload must not be null");
        this.status = Objects.requireNonNull(status, "status must not be null");
        this.retryCount = retryCount;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt must not be null");
        this.publishedAt = publishedAt;
        this.version = version;
    }

    public static OutboxEvent pending(
            String aggregateType, String aggregateId, String eventType, String payload) {
        return new OutboxEvent(
                UUID.randomUUID(),
                aggregateType,
                aggregateId,
                eventType,
                payload,
                STATUS_PENDING,
                0,
                Instant.now(),
                null,
                0);
    }

    public void markPublished(Instant timestamp) {
        this.status = STATUS_PUBLISHED;
        this.publishedAt = Objects.requireNonNull(timestamp, "timestamp must not be null");
        this.version++;
    }

    public void recordRetryFailure() {
        this.retryCount++;
        if (this.retryCount >= 5) {
            this.status = STATUS_FAILED;
        }
        this.version++;
    }

    public OutboxEvent copy() {
        return new OutboxEvent(
                eventId,
                aggregateType,
                aggregateId,
                eventType,
                payload,
                status,
                retryCount,
                createdAt,
                publishedAt,
                version);
    }

    public UUID getEventId() { return eventId; }
    public String getAggregateType() { return aggregateType; }
    public String getAggregateId() { return aggregateId; }
    public String getEventType() { return eventType; }
    public String getPayload() { return payload; }
    public String getStatus() { return status; }
    public int getRetryCount() { return retryCount; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getPublishedAt() { return publishedAt; }
    public int getVersion() { return version; }
}
