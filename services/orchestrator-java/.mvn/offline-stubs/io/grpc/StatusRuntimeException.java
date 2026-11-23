package io.grpc;

public class StatusRuntimeException extends RuntimeException {
    private final Status status;
    private final Metadata trailers;

    public StatusRuntimeException(Status status) {
        this(status, null);
    }

    public StatusRuntimeException(Status status, Metadata trailers) {
        super(status.getDescription() != null
                ? status.getCode() + ": " + status.getDescription()
                : status.getCode().name(), status.getCause());
        this.status = status;
        this.trailers = trailers;
    }

    public Status getStatus() {
        return status;
    }

    public Metadata getTrailers() {
        return trailers;
    }
}
