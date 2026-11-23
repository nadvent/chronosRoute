package io.grpc;

import java.util.concurrent.TimeUnit;

public abstract class ManagedChannel extends Channel {
    public abstract ManagedChannel shutdown();
    public abstract boolean isShutdown();
    public abstract boolean isTerminated();
    public abstract ManagedChannel shutdownNow();
    public abstract boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException;
}
