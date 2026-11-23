package io.grpc;

public final class Status {
    public enum Code {
        OK(0),
        CANCELLED(1),
        UNKNOWN(2),
        INVALID_ARGUMENT(3),
        DEADLINE_EXCEEDED(4),
        NOT_FOUND(5),
        ALREADY_EXISTS(6),
        PERMISSION_DENIED(7),
        RESOURCE_EXHAUSTED(8),
        FAILED_PRECONDITION(9),
        ABORTED(10),
        OUT_OF_RANGE(11),
        UNIMPLEMENTED(12),
        INTERNAL(13),
        UNAVAILABLE(14),
        DATA_LOSS(15),
        UNAUTHENTICATED(16);

        private final int value;

        Code(int value) {
            this.value = value;
        }

        public int value() {
            return value;
        }

        public Status toStatus() {
            return new Status(this, null, null);
        }
    }

    public static final Status OK = Code.OK.toStatus();
    public static final Status CANCELLED = Code.CANCELLED.toStatus();
    public static final Status DEADLINE_EXCEEDED = Code.DEADLINE_EXCEEDED.toStatus();
    public static final Status UNAVAILABLE = Code.UNAVAILABLE.toStatus();
    public static final Status INTERNAL = Code.INTERNAL.toStatus();

    private final Code code;
    private final String description;
    private final Throwable cause;

    public Status(Code code, String description, Throwable cause) {
        this.code = code;
        this.description = description;
        this.cause = cause;
    }

    public Code getCode() {
        return code;
    }

    public String getDescription() {
        return description;
    }

    public Throwable getCause() {
        return cause;
    }

    public Status withDescription(String description) {
        return new Status(this.code, description, this.cause);
    }

    public Status withCause(Throwable cause) {
        return new Status(this.code, this.description, cause);
    }

    public StatusRuntimeException asRuntimeException() {
        return new StatusRuntimeException(this);
    }
}
