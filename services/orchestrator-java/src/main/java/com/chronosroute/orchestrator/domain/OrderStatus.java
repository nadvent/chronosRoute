package com.chronosroute.orchestrator.domain;

import java.util.EnumSet;
import java.util.Set;

/**
 * Deterministic Order State Machine for ChronosRoute.
 *
 * <p>Enforces strict legal transitions:
 * <ul>
 *   <li>{@code PENDING -> BATCHING, CANCELLED}</li>
 *   <li>{@code BATCHING -> ASSIGNED, PENDING (fallback on timeout/unassigned), FAILED, CANCELLED}</li>
 *   <li>{@code ASSIGNED -> PICKED_UP, CANCELLED, FAILED}</li>
 *   <li>{@code PICKED_UP -> IN_TRANSIT, DELIVERED, FAILED}</li>
 *   <li>{@code IN_TRANSIT -> DELIVERED, FAILED}</li>
 *   <li>{@code DELIVERED, FAILED, CANCELLED -> terminal states (no outbound transitions)}</li>
 * </ul>
 */
public enum OrderStatus {
    PENDING,
    BATCHING,
    ASSIGNED,
    PICKED_UP,
    IN_TRANSIT,
    DELIVERED,
    FAILED,
    CANCELLED;

    private Set<OrderStatus> allowedTargets;

    static {
        PENDING.allowedTargets = EnumSet.of(BATCHING, CANCELLED);
        BATCHING.allowedTargets = EnumSet.of(ASSIGNED, PENDING, FAILED, CANCELLED);
        ASSIGNED.allowedTargets = EnumSet.of(PICKED_UP, CANCELLED, FAILED);
        PICKED_UP.allowedTargets = EnumSet.of(IN_TRANSIT, DELIVERED, FAILED);
        IN_TRANSIT.allowedTargets = EnumSet.of(DELIVERED, FAILED);
        DELIVERED.allowedTargets = EnumSet.noneOf(OrderStatus.class);
        FAILED.allowedTargets = EnumSet.noneOf(OrderStatus.class);
        CANCELLED.allowedTargets = EnumSet.noneOf(OrderStatus.class);
    }

    public boolean canTransitionTo(OrderStatus next) {
        if (next == null) {
            return false;
        }
        return allowedTargets.contains(next);
    }

    public OrderStatus transitionTo(OrderStatus next) {
        if (!canTransitionTo(next)) {
            throw new IllegalStateTransitionException(this, next);
        }
        return next;
    }

    public boolean isTerminal() {
        return allowedTargets.isEmpty();
    }

    public Set<OrderStatus> allowedTransitions() {
        return EnumSet.copyOf(allowedTargets);
    }
}
