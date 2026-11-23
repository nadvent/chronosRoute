package com.chronosroute.orchestrator.domain;

/**
 * Thrown when an optimistic locking {@code @Version} check fails during concurrent mutation.
 */
public final class OptimisticLockConflictException extends RuntimeException {
    private final String entityType;
    private final String entityId;
    private final int expectedVersion;
    private final int actualVersion;

    public OptimisticLockConflictException(
            String entityType, String entityId, int expectedVersion, int actualVersion) {
        super("Optimistic lock conflict on " + entityType + "[" + entityId + "]: expected version "
                + expectedVersion + " but found " + actualVersion);
        this.entityType = entityType;
        this.entityId = entityId;
        this.expectedVersion = expectedVersion;
        this.actualVersion = actualVersion;
    }

    public String getEntityType() {
        return entityType;
    }

    public String getEntityId() {
        return entityId;
    }

    public int getExpectedVersion() {
        return expectedVersion;
    }

    public int getActualVersion() {
        return actualVersion;
    }
}
