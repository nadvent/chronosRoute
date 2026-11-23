package com.chronosroute.orchestrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.chronosroute.orchestrator.domain.Courier;
import com.chronosroute.orchestrator.domain.CourierStatus;
import com.chronosroute.orchestrator.domain.GeoPoint;
import com.chronosroute.orchestrator.domain.IdempotencyRecord;
import com.chronosroute.orchestrator.domain.OptimisticLockConflictException;
import com.chronosroute.orchestrator.domain.Order;
import com.chronosroute.orchestrator.domain.OrderStatus;
import com.chronosroute.orchestrator.domain.OutboxEvent;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchBatchResult;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchTriggerRequest;
import com.chronosroute.orchestrator.grpc.SolverGrpcClient;
import com.chronosroute.orchestrator.repository.DispatchRepository;
import com.chronosroute.orchestrator.service.OrderDispatchService;
import com.chronosroute.orchestrator.service.VirtualThreadBulkhead;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

@Tag("integration")
@Tag("concurrency")
class DispatchConcurrencyIT {

    @Test
    void testSkipLockedConcurrentDispatchZeroDoubleClaimAcross16VirtualThreads() throws Exception {
        final int totalOrders = 160;
        final int workerThreads = 16;
        final int batchSizePerWorker = 10;

        DispatchRepository repository = new DispatchRepository();
        VirtualThreadBulkhead bulkhead = new VirtualThreadBulkhead(12);
        SolverGrpcClient solverClient = new SolverGrpcClient();
        OrderDispatchService dispatchService =
                new OrderDispatchService(repository, bulkhead, solverClient);

        UUID hubId = UUID.randomUUID();
        Instant now = Instant.now();

        for (int i = 0; i < totalOrders; i++) {
            Order order = Order.createNew(
                    hubId,
                    new BigDecimal("2.00"),
                    new GeoPoint(1.3000 + (i * 0.0005), 103.8000 + (i * 0.0005)),
                    new GeoPoint(1.3100 + (i * 0.0005), 103.8100 + (i * 0.0005)),
                    1000L + i,
                    now,
                    now.plusSeconds(7200),
                    120);
            repository.saveNewOrder(order);
        }

        for (int c = 0; c < 20; c++) {
            Courier courier = new Courier(
                    UUID.randomUUID(),
                    "Courier-" + c,
                    CourierStatus.IDLE,
                    new BigDecimal("50.00"),
                    new BigDecimal("50.00"),
                    new GeoPoint(1.3050, 103.8050),
                    now,
                    now.minusSeconds(600),
                    now.plusSeconds(14400),
                    now,
                    0);
            repository.saveCourier(courier);
        }

        Set<UUID> globallyClaimedOrders = ConcurrentHashMap.newKeySet();
        CountDownLatch startGate = new CountDownLatch(1);

        try (ExecutorService vThreadExecutor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<DispatchBatchResult>> futures = new ArrayList<>(workerThreads);
            for (int w = 0; w < workerThreads; w++) {
                final int workerId = w;
                Callable<DispatchBatchResult> workerTask = () -> {
                    startGate.await(5, TimeUnit.SECONDS);
                    return dispatchService.dispatchBatch(
                            new DispatchTriggerRequest(hubId, batchSizePerWorker, 0.2),
                            "idem-concurrent-worker-" + workerId,
                            "trace-worker-" + workerId);
                };
                futures.add(vThreadExecutor.submit(workerTask));
            }

            startGate.countDown();

            int totalAssignedAcrossWorkers = 0;
            for (Future<DispatchBatchResult> future : futures) {
                DispatchBatchResult batchResult = future.get(10, TimeUnit.SECONDS);
                for (UUID orderId : batchResult.assignedOrderIds()) {
                    boolean unique = globallyClaimedOrders.add(orderId);
                    assertTrue(
                            unique,
                            "Double-dispatch violation: order " + orderId + " assigned to multiple workers!");
                    totalAssignedAcrossWorkers++;
                }
            }

            assertEquals(
                    totalOrders,
                    totalAssignedAcrossWorkers,
                    "All 160 pending orders must be claimed and assigned across the 16 workers");
            assertEquals(totalOrders, globallyClaimedOrders.size());
            assertTrue(
                    bulkhead.getPeakConcurrentHolders() <= bulkhead.getMaxPermits(),
                    "Semaphore bulkhead must bound concurrent active DB batch workers to <= 12");
        }
    }

    @Test
    void testOptimisticLockVersionRaceDetectsConcurrentModification() {
        DispatchRepository repository = new DispatchRepository();
        UUID hubId = UUID.randomUUID();
        Instant now = Instant.now();
        Order order = repository.saveNewOrder(Order.createNew(
                hubId,
                new BigDecimal("5.00"),
                new GeoPoint(1.35, 103.82),
                new GeoPoint(1.36, 103.83),
                500L,
                now,
                now.plusSeconds(3600),
                180));

        Order workerACopy = repository.findOrderById(order.getOrderId()).orElseThrow();
        Order workerBCopy = repository.findOrderById(order.getOrderId()).orElseThrow();

        workerACopy.transitionTo(OrderStatus.BATCHING);
        Order updatedA = repository.updateOrderWithOptimisticLock(workerACopy, 0);
        assertEquals(1, updatedA.getVersion());

        workerBCopy.transitionTo(OrderStatus.CANCELLED);
        assertThrows(
                OptimisticLockConflictException.class,
                () -> repository.updateOrderWithOptimisticLock(workerBCopy, 0),
                "Second worker with stale @Version=0 must fail with OptimisticLockConflictException");
    }

    @Test
    void testJdbcDataSourceRepositoryOperationsAndFallback() {
        DataSource jdbcDataSource = createLocalPostgresDataSource();
        DispatchRepository repository = new DispatchRepository(jdbcDataSource);
        UUID hubId = UUID.randomUUID();
        Instant now = Instant.now();

        Order savedOrder = repository.saveNewOrder(Order.createNew(
                hubId,
                new BigDecimal("3.75"),
                new GeoPoint(1.3510, 103.8190),
                new GeoPoint(1.3610, 103.8290),
                777L,
                now,
                now.plusSeconds(3600),
                180));
        Order loadedOrder = repository.findOrderById(savedOrder.getOrderId()).orElseThrow();
        assertEquals(savedOrder.getOrderId(), loadedOrder.getOrderId());
        assertEquals(OrderStatus.PENDING, loadedOrder.getStatus());

        Courier savedCourier = repository.saveCourier(new Courier(
                UUID.randomUUID(),
                "Jdbc-Courier-1",
                CourierStatus.IDLE,
                new BigDecimal("40.00"),
                new BigDecimal("40.00"),
                new GeoPoint(1.3515, 103.8195),
                now,
                now.minusSeconds(600),
                now.plusSeconds(14400),
                now,
                0));
        Courier loadedCourier = repository.findCourierById(savedCourier.getCourierId()).orElseThrow();
        assertEquals(savedCourier.getCourierId(), loadedCourier.getCourierId());
        assertTrue(!repository.findAvailableCouriers(10).isEmpty());

        OutboxEvent outbox = repository.insertOutboxEvent(OutboxEvent.pending(
                "ORDER",
                savedOrder.getOrderId().toString(),
                "ORDER_CREATED",
                "{\"orderId\":\"" + savedOrder.getOrderId() + "\"}"));
        repository.markOutboxEventPublished(outbox.getEventId(), Instant.now());

        String idemKey = "idem-jdbc-" + UUID.randomUUID();
        boolean firstInsert = repository.saveIdempotencyRecordIfAbsent(new IdempotencyRecord(
                idemKey,
                "ORDER",
                savedOrder.getOrderId().toString(),
                201,
                "{\"status\":\"CREATED\"}",
                now,
                now.plusSeconds(3600),
                0));
        assertTrue(firstInsert);
        assertTrue(repository.findIdempotencyRecord(idemKey).isPresent());
    }

    private static DataSource createLocalPostgresDataSource() {
        final String url = "jdbc:postgresql://localhost:5432/chronos_route?connectTimeout=2";
        final String user = "chronos";
        final String password = "chronos_dev_password";
        return new DataSource() {
            @Override
            public Connection getConnection() throws SQLException {
                return DriverManager.getConnection(url, user, password);
            }

            @Override
            public Connection getConnection(String username, String pw) throws SQLException {
                return DriverManager.getConnection(url, username, pw);
            }

            @Override
            public PrintWriter getLogWriter() { return null; }

            @Override
            public void setLogWriter(PrintWriter out) {}

            @Override
            public void setLoginTimeout(int seconds) {}

            @Override
            public int getLoginTimeout() { return 2; }

            @Override
            public Logger getParentLogger() { return Logger.getGlobal(); }

            @Override
            public <T> T unwrap(Class<T> iface) throws SQLException {
                throw new SQLException("Not a wrapper");
            }

            @Override
            public boolean isWrapperFor(Class<?> iface) { return false; }
        };
    }
}
