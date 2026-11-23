package com.chronosroute.orchestrator.domain;

import jakarta.persistence.Version;
import java.time.Instant;
import java.util.Objects;

/**
 * Idempotency record stored in {@code idempotency_keys} to guarantee safe HTTP/stream retry replay.
 */
public final class IdempotencyRecord {
    private final String keyId;
    private final String aggregateType;
    private final String aggregateId;
    private final int responseCode;
    private final String responsePayload;
    private final Instant createdAt;
    private final Instant expiresAt;

    @Version
    private final int version;

    public IdempotencyRecord(
            String keyId,
            String aggregateType,
            String aggregateId,
            int responseCode,
            String responsePayload,
            Instant createdAt,
            Instant expiresAt,
            int version) {
        if (keyId == null || keyId.isBlank()) {
            throw new IllegalArgumentException("Idempotency keyId must not be blank");
        }
        this.keyId = keyId;
        this.aggregateType = Objects.requireNonNull(aggregateType, "aggregateType must not be null");
        this.aggregateId = Objects.requireNonNull(aggregateId, "aggregateId must not be null");
        this.responseCode = responseCode;
        this.responsePayload = Objects.requireNonNull(responsePayload, "responsePayload must not be null");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt must not be null");
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt must not be null");
        this.version = version;
    }

    public boolean isExpired(Instant now) {
        return !expiresAt.isAfter(now);
    }

    public String getKeyId() { return keyId; }
    public String getAggregateType() { return aggregateType; }
    public String getAggregateId() { return aggregateId; }
    public int getResponseCode() { return responseCode; }
    public String getResponsePayload() { return responsePayload; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getExpiresAt() { return expiresAt; }
    public int getVersion() { return version; }
}
