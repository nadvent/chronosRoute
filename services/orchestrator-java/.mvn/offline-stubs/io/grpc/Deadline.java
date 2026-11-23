package io.grpc;

import java.util.concurrent.TimeUnit;

public final class Deadline implements Comparable<Deadline> {
    private final long deadlineNanos;

    private Deadline(long deadlineNanos) {
        this.deadlineNanos = deadlineNanos;
    }

    public static Deadline after(long duration, TimeUnit units) {
        return new Deadline(System.nanoTime() + units.toNanos(duration));
    }

    public boolean isExpired() {
        return System.nanoTime() >= deadlineNanos;
    }

    public long timeRemaining(TimeUnit unit) {
        return unit.convert(deadlineNanos - System.nanoTime(), TimeUnit.NANOSECONDS);
    }

    @Override
    public int compareTo(Deadline that) {
        return Long.compare(this.deadlineNanos, that.deadlineNanos);
    }
}
