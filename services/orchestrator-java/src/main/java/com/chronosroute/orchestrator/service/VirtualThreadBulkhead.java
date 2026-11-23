package com.chronosroute.orchestrator.service;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Virtual-Thread-safe concurrency bulkhead that bounds simultaneous heavy database batch
 * operations against HikariCP's finite connection pool ({@code maximum-pool-size=32}).
 *
 * <p>Uses {@link Semaphore} (fair=true) and {@link ReentrantLock} so blocking Virtual Threads
 * cleanly unmount from OS carrier threads without pinning.
 */
@Component
public class VirtualThreadBulkhead {
    public static final int DEFAULT_MAX_CONCURRENT_BATCHES = 24;
    public static final Duration DEFAULT_ACQUIRE_TIMEOUT = Duration.ofSeconds(5);

    private final int maxPermits;
    private final Semaphore semaphore;
    private final ReentrantLock statsLock = new ReentrantLock();
    private final AtomicInteger currentHolders = new AtomicInteger(0);
    private final AtomicInteger peakConcurrentHolders = new AtomicInteger(0);
    private final AtomicLong totalAcquisitions = new AtomicLong(0);
    private final AtomicLong totalRejections = new AtomicLong(0);

    public VirtualThreadBulkhead() {
        this(DEFAULT_MAX_CONCURRENT_BATCHES);
    }

    @Autowired
    public VirtualThreadBulkhead(
            @Value("${chronos.bulkhead.max-permits:24}") int maxPermits) {
        if (maxPermits <= 0 || maxPermits > 32) {
            throw new IllegalArgumentException(
                    "Bulkhead maxPermits must be in [1, 32] (HikariCP pool upper bound): " + maxPermits);
        }
        this.maxPermits = maxPermits;
        this.semaphore = new Semaphore(maxPermits, true);
    }

    public void acquirePermit(Duration timeout) {
        Objects.requireNonNull(timeout, "timeout must not be null");
        boolean acquired;
        try {
            acquired = semaphore.tryAcquire(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            totalRejections.incrementAndGet();
            throw new IllegalStateException("Interrupted while waiting for bulkhead permit", e);
        }
        if (!acquired) {
            totalRejections.incrementAndGet();
            throw new BulkheadRejectedException(
                    "Timed out after " + timeout.toMillis() + "ms waiting for DB batch bulkhead permit (max="
                            + maxPermits + ")");
        }

        statsLock.lock();
        try {
            int active = currentHolders.incrementAndGet();
            totalAcquisitions.incrementAndGet();
            if (active > peakConcurrentHolders.get()) {
                peakConcurrentHolders.set(active);
            }
        } finally {
            statsLock.unlock();
        }
    }

    public void releasePermit() {
        statsLock.lock();
        try {
            currentHolders.decrementAndGet();
        } finally {
            statsLock.unlock();
            semaphore.release();
        }
    }

    public <T> T executeWithPermit(Callable<T> task) {
        return executeWithPermit(task, DEFAULT_ACQUIRE_TIMEOUT);
    }

    public <T> T executeWithPermit(Callable<T> task, Duration acquireTimeout) {
        acquirePermit(acquireTimeout);
        try {
            return task.call();
        } catch (RuntimeException re) {
            throw re;
        } catch (Exception e) {
            throw new IllegalStateException("Bulkhead task execution failed", e);
        } finally {
            releasePermit();
        }
    }

    public int getMaxPermits() {
        return maxPermits;
    }

    public int getAvailablePermits() {
        return semaphore.availablePermits();
    }

    public int getActiveHolders() {
        return currentHolders.get();
    }

    public int getPeakConcurrentHolders() {
        return peakConcurrentHolders.get();
    }

    public long getTotalAcquisitions() {
        return totalAcquisitions.get();
    }

    public long getTotalRejections() {
        return totalRejections.get();
    }

    public static final class BulkheadRejectedException extends RuntimeException {
        public BulkheadRejectedException(String message) {
            super(message);
        }
    }
}
