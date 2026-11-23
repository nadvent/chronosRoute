package io.grpc;

import java.util.concurrent.TimeUnit;

public final class CallOptions {
    public static final CallOptions DEFAULT = new CallOptions(null);

    private final Deadline deadline;

    private CallOptions(Deadline deadline) {
        this.deadline = deadline;
    }

    public CallOptions withDeadline(Deadline newDeadline) {
        return new CallOptions(newDeadline);
    }

    public CallOptions withDeadlineAfter(long duration, TimeUnit unit) {
        return new CallOptions(Deadline.after(duration, unit));
    }

    public Deadline getDeadline() {
        return deadline;
    }
}
