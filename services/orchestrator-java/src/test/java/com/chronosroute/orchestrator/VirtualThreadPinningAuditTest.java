package com.chronosroute.orchestrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.chronosroute.orchestrator.controller.DispatchController;
import com.chronosroute.orchestrator.domain.Courier;
import com.chronosroute.orchestrator.domain.CourierStatus;
import com.chronosroute.orchestrator.domain.GeoPoint;
import com.chronosroute.orchestrator.domain.IdempotencyRecord;
import com.chronosroute.orchestrator.domain.Order;
import com.chronosroute.orchestrator.domain.OrderStatus;
import com.chronosroute.orchestrator.domain.OutboxEvent;
import com.chronosroute.orchestrator.dto.OrderDtos;
import com.chronosroute.orchestrator.grpc.SolverGrpcClient;
import com.chronosroute.orchestrator.grpc.TraceIdClientInterceptor;
import com.chronosroute.orchestrator.repository.DispatchRepository;
import com.chronosroute.orchestrator.service.OrderDispatchService;
import com.chronosroute.orchestrator.service.RedisStreamOrchestrator;
import com.chronosroute.orchestrator.service.VirtualThreadBulkhead;
import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

@Tag("loom-audit")
@Tag("unit")
class VirtualThreadPinningAuditTest {

    private static final Pattern SYNCHRONIZED_KEYWORD_PATTERN =
            Pattern.compile("\\bsynchronized\\b");

    @Test
    void testZeroSynchronizedMethodsOrBlocksInProductionCode() throws IOException {
        Class<?>[] productionClasses = new Class<?>[] {
            ChronosRouteApplication.class,
            OrderStatus.class,
            CourierStatus.class,
            GeoPoint.class,
            Order.class,
            Courier.class,
            OutboxEvent.class,
            IdempotencyRecord.class,
            OrderDtos.class,
            DispatchRepository.class,
            VirtualThreadBulkhead.class,
            TraceIdClientInterceptor.class,
            SolverGrpcClient.class,
            OrderDispatchService.class,
            RedisStreamOrchestrator.class,
            DispatchController.class
        };

        for (Class<?> clazz : productionClasses) {
            for (Method method : clazz.getDeclaredMethods()) {
                assertTrue(
                        (method.getModifiers() & Modifier.SYNCHRONIZED) == 0,
                        "Pinning hazard: method " + clazz.getName() + "#" + method.getName()
                                + " uses Modifier.SYNCHRONIZED");
            }
        }

        Path mainSrcRoot = Path.of("src/main/java");
        if (Files.isDirectory(mainSrcRoot)) {
            try (Stream<Path> paths = Files.walk(mainSrcRoot)) {
                List<Path> javaFiles = paths.filter(p -> p.toString().endsWith(".java")).toList();
                assertTrue(!javaFiles.isEmpty(), "Expected Java source files under src/main/java");
                for (Path file : javaFiles) {
                    String stripped = stripCommentsAndStrings(Files.readString(file));
                    boolean hasSynchronized = SYNCHRONIZED_KEYWORD_PATTERN.matcher(stripped).find();
                    assertTrue(
                            !hasSynchronized,
                            "Pinning hazard: found 'synchronized' keyword in " + file);
                }
            }
        }
    }

    @Test
    void testVirtualThreadBulkheadAndReentrantLockConcurrencyWithoutCarrierPinning() throws Exception {
        final int maxBulkheadPermits = 8;
        final int concurrentVirtualThreads = 64;

        VirtualThreadBulkhead bulkhead = new VirtualThreadBulkhead(maxBulkheadPermits);
        ReentrantLock stateLock = new ReentrantLock();
        Set<String> virtualThreadNames = ConcurrentHashMap.newKeySet();

        try (ExecutorService vExecutor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<Boolean>> tasks = new ArrayList<>(concurrentVirtualThreads);
            for (int i = 0; i < concurrentVirtualThreads; i++) {
                tasks.add(vExecutor.submit(() -> bulkhead.executeWithPermit(
                        () -> {
                            assertTrue(
                                    Thread.currentThread().isVirtual(),
                                    "Task must execute on a Java 21+ Virtual Thread");
                            virtualThreadNames.add(Thread.currentThread().toString());
                            stateLock.lock();
                            try {
                                assertTrue(
                                        bulkhead.getActiveHolders() <= maxBulkheadPermits,
                                        "Active holders exceeded Semaphore upper bound");
                            } finally {
                                stateLock.unlock();
                            }
                            // Simulate blocking I/O unmount while holding Semaphore permit (outside lock)
                            Thread.sleep(5);
                            return true;
                        },
                        Duration.ofSeconds(5))));
            }

            for (Future<Boolean> future : tasks) {
                assertTrue(future.get(10, TimeUnit.SECONDS));
            }
        }

        assertEquals(concurrentVirtualThreads, bulkhead.getTotalAcquisitions());
        assertEquals(0L, bulkhead.getTotalRejections());
        assertEquals(maxBulkheadPermits, bulkhead.getAvailablePermits());
        assertTrue(
                bulkhead.getPeakConcurrentHolders() <= maxBulkheadPermits,
                "Peak concurrent holders (" + bulkhead.getPeakConcurrentHolders()
                        + ") must never exceed maxPermits (" + maxBulkheadPermits + ")");
    }

    private static String stripCommentsAndStrings(String source) {
        String noBlockComments = source.replaceAll("(?s)/\\*.*?\\*/", " ");
        String noLineComments = noBlockComments.replaceAll("(?m)//.*$", " ");
        return noLineComments.replaceAll("\"(?:\\\\.|[^\"\\\\])*\"", "\"\"");
    }
}
