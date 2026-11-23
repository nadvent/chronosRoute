package com.chronosroute.orchestrator.domain;

/**
 * Thrown when an order or courier attempts an illegal state machine transition.
 */
public final class IllegalStateTransitionException extends RuntimeException {
    private final OrderStatus fromStatus;
    private final OrderStatus toStatus;

    public IllegalStateTransitionException(OrderStatus fromStatus, OrderStatus toStatus) {
        super("Illegal order state transition from " + fromStatus + " to " + toStatus);
        this.fromStatus = fromStatus;
        this.toStatus = toStatus;
    }

    public IllegalStateTransitionException(String message) {
        super(message);
        this.fromStatus = null;
        this.toStatus = null;
    }

    public OrderStatus getFromStatus() {
        return fromStatus;
    }

    public OrderStatus getToStatus() {
        return toStatus;
    }
}
