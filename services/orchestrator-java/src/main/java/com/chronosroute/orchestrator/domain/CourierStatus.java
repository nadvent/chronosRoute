package com.chronosroute.orchestrator.domain;

import java.util.EnumSet;
import java.util.Set;

/**
 * Courier shift and dispatch status matching PostgreSQL {@code courier_status} enum.
 */
public enum CourierStatus {
    OFFLINE,
    IDLE,
    ASSIGNED,
    EN_ROUTE_PICKUP,
    EN_ROUTE_DROPOFF;

    private Set<CourierStatus> allowedTargets;

    static {
        OFFLINE.allowedTargets = EnumSet.of(IDLE);
        IDLE.allowedTargets = EnumSet.of(ASSIGNED, OFFLINE);
        ASSIGNED.allowedTargets = EnumSet.of(EN_ROUTE_PICKUP, IDLE, OFFLINE);
        EN_ROUTE_PICKUP.allowedTargets = EnumSet.of(EN_ROUTE_DROPOFF, IDLE);
        EN_ROUTE_DROPOFF.allowedTargets = EnumSet.of(EN_ROUTE_PICKUP, IDLE, OFFLINE);
    }

    public boolean canTransitionTo(CourierStatus next) {
        return next != null && allowedTargets.contains(next);
    }

    public CourierStatus transitionTo(CourierStatus next) {
        if (!canTransitionTo(next)) {
            throw new IllegalStateTransitionException(
                    "Illegal courier state transition from " + this + " to " + next);
        }
        return next;
    }

    public boolean isAvailableForDispatch() {
        return this == IDLE || this == ASSIGNED;
    }
}
