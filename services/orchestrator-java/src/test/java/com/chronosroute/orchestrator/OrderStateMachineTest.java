package com.chronosroute.orchestrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.chronosroute.orchestrator.controller.DispatchController;
import com.chronosroute.orchestrator.domain.Courier;
import com.chronosroute.orchestrator.domain.CourierStatus;
import com.chronosroute.orchestrator.domain.GeoPoint;
import com.chronosroute.orchestrator.domain.IllegalStateTransitionException;
import com.chronosroute.orchestrator.domain.OptimisticLockConflictException;
import com.chronosroute.orchestrator.domain.Order;
import com.chronosroute.orchestrator.domain.OrderStatus;
import com.chronosroute.orchestrator.domain.OutboxEvent;
import com.chronosroute.orchestrator.dto.OrderDtos.CreateOrderRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchBatchResult;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchTriggerRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.HubSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.OrchestratorMetricsResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.OrderResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.ReoptimizeRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.ReoptimizeResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.RoutePetalDto;
import com.chronosroute.orchestrator.dto.OrderDtos.SnapshotResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.WebhookStatusUpdateRequest;
import com.chronosroute.orchestrator.grpc.SolverGrpcClient;
import com.chronosroute.orchestrator.repository.DispatchRepository;
import com.chronosroute.orchestrator.service.OrderDispatchService;
import com.chronosroute.orchestrator.service.RedisStreamOrchestrator;
import com.chronosroute.orchestrator.service.VirtualThreadBulkhead;
import com.chronosroute.proto.v1.HealthResponse;
import com.chronosroute.proto.v1.TrafficUpdateResponse;
import io.grpc.Deadline;
import io.grpc.Status;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

@Tag("unit")
class OrderStateMachineTest {

    private DispatchRepository repository;
    private VirtualThreadBulkhead bulkhead;
    private SolverGrpcClient solverClient;
    private OrderDispatchService dispatchService;
    private RedisStreamOrchestrator streamOrchestrator;
    private DispatchController controller;
    private UUID defaultHubId;

    @BeforeEach
    void setUp() {
        repository = new DispatchRepository();
        bulkhead = new VirtualThreadBulkhead(24);
        solverClient = new SolverGrpcClient();
        dispatchService = new OrderDispatchService(repository, bulkhead, solverClient);
        streamOrchestrator = new RedisStreamOrchestrator(repository, bulkhead);
        controller = new DispatchController(dispatchService, bulkhead);
        defaultHubId = UUID.randomUUID();
    }

    @AfterEach
    void tearDown() {
        if (solverClient != null) {
            solverClient.shutdown();
        }
    }

    @Test
    void testLegalOrderStateMachineLifecycle() {
        Order order = createSampleOrder();
        assertEquals(OrderStatus.PENDING, order.getStatus());

        order.transitionTo(OrderStatus.BATCHING);
        assertEquals(OrderStatus.BATCHING, order.getStatus());

        UUID courierId = UUID.randomUUID();
        order.assignToCourier(courierId);
        assertEquals(OrderStatus.ASSIGNED, order.getStatus());
        assertEquals(courierId, order.getCourierId());

        order.transitionTo(OrderStatus.PICKED_UP);
        assertEquals(OrderStatus.PICKED_UP, order.getStatus());

        order.transitionTo(OrderStatus.IN_TRANSIT);
        assertEquals(OrderStatus.IN_TRANSIT, order.getStatus());

        order.transitionTo(OrderStatus.DELIVERED);
        assertEquals(OrderStatus.DELIVERED, order.getStatus());
        assertTrue(order.getStatus().isTerminal());
    }

    @Test
    void testBatchingFallbackToPendingTransition() {
        Order order = createSampleOrder();
        order.transitionTo(OrderStatus.BATCHING);
        assertEquals(OrderStatus.BATCHING, order.getStatus());

        order.releaseToPending();
        assertEquals(OrderStatus.PENDING, order.getStatus());
        assertNull(order.getCourierId());
    }

    @Test
    void testIllegalOrderStateTransitionsThrowException() {
        Order pendingOrder = createSampleOrder();
        assertThrows(
                IllegalStateTransitionException.class,
                () -> pendingOrder.transitionTo(OrderStatus.DELIVERED));
        assertThrows(
                IllegalStateTransitionException.class,
                () -> pendingOrder.transitionTo(OrderStatus.PICKED_UP));
        assertThrows(
                IllegalStateTransitionException.class,
                () -> pendingOrder.transitionTo(OrderStatus.IN_TRANSIT));
        assertThrows(
                IllegalStateTransitionException.class,
                () -> pendingOrder.transitionTo(OrderStatus.ASSIGNED));

        Order deliveredOrder = createSampleOrder();
        deliveredOrder.transitionTo(OrderStatus.BATCHING);
        deliveredOrder.assignToCourier(UUID.randomUUID());
        deliveredOrder.transitionTo(OrderStatus.PICKED_UP);
        deliveredOrder.transitionTo(OrderStatus.DELIVERED);

        for (OrderStatus target : OrderStatus.values()) {
            assertFalse(deliveredOrder.getStatus().canTransitionTo(target));
            assertThrows(
                    IllegalStateTransitionException.class,
                    () -> deliveredOrder.transitionTo(target));
        }
    }

    @Test
    void testIdempotencyReplayOnOrderCreationAndDispatch() {
        CreateOrderRequest req = new CreateOrderRequest(
                defaultHubId,
                new BigDecimal("4.50"),
                1.3521,
                103.8198,
                1.3600,
                103.8300,
                1001L,
                Instant.now(),
                Instant.now().plusSeconds(3600),
                180);

        ResponseEntity<OrderResponse> firstCreate =
                controller.createOrder(req, "idem-order-001", "trace-create-1");
        assertEquals(HttpStatus.CREATED, firstCreate.getStatusCode());
        assertFalse(firstCreate.getBody().replayedFromIdempotency());

        ResponseEntity<OrderResponse> secondCreate =
                controller.createOrder(req, "idem-order-001", "trace-create-2");
        assertEquals(HttpStatus.OK, secondCreate.getStatusCode());
        assertTrue(secondCreate.getBody().replayedFromIdempotency());
        assertEquals(firstCreate.getBody().orderId(), secondCreate.getBody().orderId());

        // Seed an available courier and trigger dispatch twice with the same Idempotency-Key
        repository.saveCourier(createSampleCourier(List.of()));

        AtomicInteger solverInvocations = new AtomicInteger(0);
        SolverGrpcClient countingSolver = new SolverGrpcClient("localhost", 50051, protoReq -> {
            solverInvocations.incrementAndGet();
            return solverClient.solveBatch(
                    protoReq.getRequestId(),
                    "trace-dispatch",
                    List.of(repository.findOrderById(firstCreate.getBody().orderId()).orElseThrow()),
                    repository.findAvailableCouriers(10));
        });
        OrderDispatchService serviceWithCounter =
                new OrderDispatchService(repository, bulkhead, countingSolver);

        DispatchTriggerRequest triggerReq = new DispatchTriggerRequest(defaultHubId, 10, 0.1);
        DispatchBatchResult firstDispatch =
                serviceWithCounter.dispatchBatch(triggerReq, "idem-dispatch-001", "trace-d1");
        assertFalse(firstDispatch.replayedFromIdempotency());
        assertEquals(1, firstDispatch.assignedOrderIds().size());
        assertEquals(1, solverInvocations.get());

        DispatchBatchResult replayedDispatch =
                serviceWithCounter.dispatchBatch(triggerReq, "idem-dispatch-001", "trace-d2");
        assertTrue(replayedDispatch.replayedFromIdempotency());
        assertEquals(firstDispatch.requestId(), replayedDispatch.requestId());
        assertEquals(1, solverInvocations.get(), "Solver must NOT be invoked on idempotent replay");
    }

    @Test
    void testGrpc450msDeadlinePropagationAndGracefulTimeoutFallback() {
        Order order1 = repository.saveNewOrder(createSampleOrder());
        Order order2 = repository.saveNewOrder(createSampleOrder());
        UUID existingRouteOrderId = UUID.randomUUID();
        Courier courierWithExistingRoute = createSampleCourier(List.of(existingRouteOrderId));
        repository.saveCourier(courierWithExistingRoute);

        AtomicBoolean txActiveDuringGrpc = new AtomicBoolean(true);
        SolverGrpcClient timeoutSolver = new SolverGrpcClient("localhost", 50051, protoReq -> {
            txActiveDuringGrpc.set(repository.isTransactionActive());
            throw Status.DEADLINE_EXCEEDED
                    .withDescription("Solver exceeded 450ms deadline budget")
                    .asRuntimeException();
        });

        OrderDispatchService fallbackService =
                new OrderDispatchService(repository, bulkhead, timeoutSolver);

        DispatchBatchResult fallbackResult = fallbackService.dispatchBatch(
                new DispatchTriggerRequest(defaultHubId, 50, 0.85),
                "idem-timeout-001",
                "trace-deadline-check");

        // 1. Verify DB transaction was NOT open during remote gRPC call
        assertFalse(
                txActiveDuringGrpc.get(),
                "Database transaction MUST be committed and closed before gRPC call");

        // 2. Verify x-trace-id header was propagated by TraceIdClientInterceptor
        assertEquals(
                "trace-deadline-check",
                timeoutSolver.getTraceInterceptor().getLastPropagatedTraceId());

        // 3. Verify 450ms hard deadline was attached to the stub
        Deadline observedDeadline = timeoutSolver.getLastObservedDeadline();
        assertNotNull(observedDeadline, "Stub must carry an explicit gRPC Deadline");
        long remainingMs = observedDeadline.timeRemaining(TimeUnit.MILLISECONDS);
        assertTrue(remainingMs <= 450L, "Deadline must not exceed 450ms budget");

        // 4. Verify degraded fallback retains existing courier routes and releases orders to PENDING
        assertTrue(fallbackResult.degradedFallback());
        assertEquals(
                OrderDispatchService.OUTCOME_DEGRADED_FALLBACK,
                fallbackResult.dispatchOutcome());
        assertEquals(1, fallbackResult.retainedExistingRoutesCount());
        assertEquals(2, fallbackResult.unassignedOrderIds().size());

        Order reloaded1 = repository.findOrderById(order1.getOrderId()).orElseThrow();
        Order reloaded2 = repository.findOrderById(order2.getOrderId()).orElseThrow();
        assertEquals(OrderStatus.PENDING, reloaded1.getStatus());
        assertEquals(OrderStatus.PENDING, reloaded2.getStatus());

        Courier reloadedCourier =
                repository.findCourierById(courierWithExistingRoute.getCourierId()).orElseThrow();
        assertEquals(List.of(existingRouteOrderId), reloadedCourier.getActiveRouteOrderIds());
    }

    @Test
    void testOutboxCreationAndCommitBeforeXackOrdering() {
        Order pendingOrder = repository.saveNewOrder(createSampleOrder());
        Courier idleCourier = repository.saveCourier(createSampleCourier(List.of()));

        DispatchBatchResult result = dispatchService.dispatchBatch(
                new DispatchTriggerRequest(defaultHubId, 10, 0.0),
                "idem-outbox-test",
                "trace-outbox-1");
        assertEquals(1, result.assignedOrderIds().size());

        List<OutboxEvent> outboxEvents = repository.findAllOutboxEvents();
        assertEquals(1, outboxEvents.size());
        assertEquals("ORDER_ASSIGNED", outboxEvents.get(0).getEventType());
        assertEquals(OutboxEvent.STATUS_PENDING, outboxEvents.get(0).getStatus());

        // Publish outbox to Redis Stream
        int published = streamOrchestrator.pollAndPublishOutboxBatch(10);
        assertEquals(1, published);
        assertEquals(
                OutboxEvent.STATUS_PUBLISHED,
                repository.findAllOutboxEvents().get(0).getStatus());

        // Push a telemetry event to telemetry:stream and consume it
        streamOrchestrator.clearExecutionOrderLog();
        String eventId = "evt-telemetry-101";
        String msgId = streamOrchestrator.xaddToStream(
                RedisStreamOrchestrator.TELEMETRY_STREAM_KEY,
                eventId,
                "COURIER_TELEMETRY_PING",
                Map.of(
                        "courier_id", idleCourier.getCourierId().toString(),
                        "lat", "1.3599",
                        "lon", "103.8299"));

        int acked = streamOrchestrator.consumeStreamBatch(
                RedisStreamOrchestrator.TELEMETRY_STREAM_KEY, "worker-1", 10, null);
        assertEquals(1, acked);
        assertTrue(streamOrchestrator.isMessageAcknowledged(msgId));

        List<String> log = streamOrchestrator.getExecutionOrderLog();
        int commitIdx = log.indexOf("DB_COMMIT:" + eventId);
        int xackIdx = log.indexOf("REDIS_XACK:" + eventId);
        assertTrue(commitIdx >= 0, "DB_COMMIT must be recorded");
        assertTrue(xackIdx > commitIdx, "REDIS_XACK must occur strictly AFTER DB_COMMIT");

        // Verify duplicate event_id delivery is deduplicated before XACK
        streamOrchestrator.clearExecutionOrderLog();
        String dupMsgId = streamOrchestrator.xaddToStream(
                RedisStreamOrchestrator.TELEMETRY_STREAM_KEY,
                eventId,
                "COURIER_TELEMETRY_PING",
                Map.of(
                        "courier_id", idleCourier.getCourierId().toString(),
                        "lat", "1.3700",
                        "lon", "103.8400"));
        int dupAcked = streamOrchestrator.consumeStreamBatch(
                RedisStreamOrchestrator.TELEMETRY_STREAM_KEY, "worker-1", 10, null);
        assertEquals(1, dupAcked);
        assertTrue(streamOrchestrator.isMessageAcknowledged(dupMsgId));
        List<String> dupLog = streamOrchestrator.getExecutionOrderLog();
        assertTrue(dupLog.contains("DB_DEDUP_SKIP:" + eventId));
        assertTrue(dupLog.indexOf("DB_COMMIT:" + eventId) < dupLog.indexOf("REDIS_XACK:" + eventId));

        // Verify failed DB transaction rolls back and NEVER issues XACK
        streamOrchestrator.clearExecutionOrderLog();
        String failingEventId = "evt-fail-999";
        String failMsgId = streamOrchestrator.xaddToStream(
                RedisStreamOrchestrator.TELEMETRY_STREAM_KEY,
                failingEventId,
                "FAIL_EVENT",
                Map.of("order_id", pendingOrder.getOrderId().toString()));

        assertThrows(
                IllegalStateException.class,
                () -> streamOrchestrator.consumeStreamBatch(
                        RedisStreamOrchestrator.TELEMETRY_STREAM_KEY,
                        "worker-1",
                        10,
                        msg -> {
                            throw new IllegalStateException("Simulated PostgreSQL serialization failure");
                        }));
        assertFalse(
                streamOrchestrator.isMessageAcknowledged(failMsgId),
                "Failed DB transaction must NEVER issue Redis XACK");
        List<String> failLog = streamOrchestrator.getExecutionOrderLog();
        assertTrue(failLog.contains("DB_ROLLBACK:" + failingEventId));
        assertFalse(failLog.contains("REDIS_XACK:" + failingEventId));
    }

    @Test
    void testOptimisticLockConflictReturns409OnController() {
        Order saved = repository.saveNewOrder(createSampleOrder());
        // Advance version from 0 -> 1 via legal transition PENDING -> CANCELLED
        ResponseEntity<OrderResponse> okResp = controller.updateOrderStatus(
                saved.getOrderId(),
                new WebhookStatusUpdateRequest(OrderStatus.CANCELLED, 0, "Customer cancelled"),
                "idem-cancel-1",
                "trace-c1");
        assertEquals(HttpStatus.OK, okResp.getStatusCode());

        // Attempt stale version update or transition from terminal CANCELLED state -> 409 CONFLICT
        ResponseEntity<OrderResponse> conflictResp = controller.updateOrderStatus(
                saved.getOrderId(),
                new WebhookStatusUpdateRequest(OrderStatus.BATCHING, 0, "Stale dispatch"),
                "idem-cancel-2",
                "trace-c2");
        assertEquals(HttpStatus.CONFLICT, conflictResp.getStatusCode());
    }

    @Test
    void testGetSnapshotIncludesHubsGeoJsonCouriersOrdersAndRoutePetals() {
        UUID londonHubId = UUID.randomUUID();
        repository.saveHub(new HubSnapshotDto(
                londonHubId, "London Central Hub", 51.5074, -0.1278, 750));

        Instant now = Instant.now();
        Order o1 = repository.saveNewOrder(Order.createNew(
                londonHubId,
                new BigDecimal("2.50"),
                new GeoPoint(51.5074, -0.1278),
                new GeoPoint(51.5150, -0.1100),
                101L,
                now,
                now.plusSeconds(3600),
                180));
        Order o2 = repository.saveNewOrder(Order.createNew(
                londonHubId,
                new BigDecimal("3.00"),
                new GeoPoint(51.5074, -0.1278),
                new GeoPoint(51.5010, -0.1420),
                102L,
                now,
                now.plusSeconds(3600),
                180));

        Courier courier = repository.saveCourier(new Courier(
                UUID.randomUUID(),
                "London-Rider-1",
                CourierStatus.IDLE,
                new BigDecimal("30.00"),
                new BigDecimal("30.00"),
                new GeoPoint(51.5080, -0.1260),
                now,
                now.minusSeconds(1800),
                now.plusSeconds(14400),
                now,
                0));

        ResponseEntity<SnapshotResponse> beforeResp = controller.snapshot(200);
        assertEquals(HttpStatus.OK, beforeResp.getStatusCode());
        SnapshotResponse beforeSnap = beforeResp.getBody();
        assertNotNull(beforeSnap);
        assertEquals(51.5074, beforeSnap.regionCenter().lat(), 0.001);
        assertEquals(-0.1278, beforeSnap.regionCenter().lon(), 0.001);
        assertEquals(1, beforeSnap.hubs().size());
        assertEquals("FeatureCollection", beforeSnap.zonesGeoJson().get("type"));
        List<?> features = (List<?>) beforeSnap.zonesGeoJson().get("features");
        assertEquals(1, features.size());
        assertEquals(1, beforeSnap.couriers().size());
        assertEquals(2, beforeSnap.orders().size());
        assertTrue(beforeSnap.routes().isEmpty());

        dispatchService.dispatchBatch(
                new DispatchTriggerRequest(londonHubId, 10, 0.1),
                "idem-snap-dispatch",
                "trace-snap-1");

        SnapshotResponse afterSnap = dispatchService.getSnapshot();
        assertEquals(1, afterSnap.routes().size());
        RoutePetalDto petal = afterSnap.routes().get(0);
        assertEquals(courier.getCourierId(), petal.courierId());
        assertEquals(2, petal.waypoints().size());
        assertEquals(3, petal.pathCoords().size());
        assertEquals(-0.1260, petal.pathCoords().get(0).get(0), 0.0001);
        assertEquals(51.5080, petal.pathCoords().get(0).get(1), 0.0001);
        assertTrue(petal.totalDistanceMeters() > 0L);
        assertFalse(petal.encodedPolyline().isBlank());
        assertEquals("SOLVER_STATUS_OPTIMAL", afterSnap.latestSolve().solverStatus());
        assertTrue(Set.of(o1.getOrderId(), o2.getOrderId())
                .contains(petal.waypoints().get(0).orderId()));

        dispatchService.clearCachedSeedState();
        SnapshotResponse clearedSnap = dispatchService.getSnapshot();
        assertTrue(clearedSnap.hubs().isEmpty());
        assertTrue(clearedSnap.orders().isEmpty());
        assertTrue(clearedSnap.routes().isEmpty());
    }

    @Test
    void testReoptimizeUpdatesTrafficAndComputesRouteDiff() {
        UUID hubId = UUID.randomUUID();
        Instant now = Instant.now();
        Order order1 = repository.saveNewOrder(Order.createNew(
                hubId,
                new BigDecimal("2.00"),
                new GeoPoint(51.5074, -0.1278),
                new GeoPoint(51.5190, -0.1150),
                201L,
                now,
                now.plusSeconds(3600),
                120));
        Order order2 = repository.saveNewOrder(Order.createNew(
                hubId,
                new BigDecimal("2.50"),
                new GeoPoint(51.5074, -0.1278),
                new GeoPoint(51.4980, -0.1390),
                202L,
                now,
                now.plusSeconds(3600),
                120));

        Courier courierA = repository.saveCourier(new Courier(
                UUID.randomUUID(),
                "Courier-A",
                CourierStatus.IDLE,
                new BigDecimal("30.00"),
                new BigDecimal("30.00"),
                new GeoPoint(51.5070, -0.1270),
                now,
                now.minusSeconds(1200),
                now.plusSeconds(14400),
                now,
                0));
        Courier courierB = repository.saveCourier(new Courier(
                UUID.randomUUID(),
                "Courier-B",
                CourierStatus.IDLE,
                new BigDecimal("30.00"),
                new BigDecimal("30.00"),
                new GeoPoint(51.5080, -0.1290),
                now,
                now.minusSeconds(1200),
                now.plusSeconds(14400),
                now,
                0));

        // First reoptimize dispatches PENDING orders with auto-generated Idempotency-Key
        ResponseEntity<ReoptimizeResponse> firstResp = controller.reoptimize(
                new ReoptimizeRequest(hubId, 20, 0.75, 0.65),
                null,
                "trace-reopt-1");
        assertEquals(HttpStatus.OK, firstResp.getStatusCode());
        ReoptimizeResponse first = firstResp.getBody();
        assertNotNull(first);
        assertEquals(OrderDispatchService.OUTCOME_ASSIGNED, first.batchResult().dispatchOutcome());
        assertTrue(first.beforeRoutes().isEmpty());
        assertFalse(first.afterRoutes().isEmpty());
        assertEquals(2, first.reassignedOrderIds().size());
        assertTrue(first.solveTelemetry().objectiveCost() > 0.0);
        assertTrue(first.solveTelemetry().iterationsCompleted() > 0);

        // Second reoptimize with 0 PENDING orders re-solves active ASSIGNED routes cleanly
        ResponseEntity<ReoptimizeResponse> secondResp = controller.reoptimize(
                new ReoptimizeRequest(hubId, 20, 0.90, 0.50),
                "",
                "trace-reopt-2");
        assertEquals(HttpStatus.OK, secondResp.getStatusCode());
        ReoptimizeResponse second = secondResp.getBody();
        assertNotNull(second);
        assertEquals(OrderDispatchService.OUTCOME_ASSIGNED, second.batchResult().dispatchOutcome());
        assertFalse(second.beforeRoutes().isEmpty());
        assertFalse(second.afterRoutes().isEmpty());
        assertEquals(OrderStatus.ASSIGNED,
                repository.findOrderById(order1.getOrderId()).orElseThrow().getStatus());
        assertEquals(OrderStatus.ASSIGNED,
                repository.findOrderById(order2.getOrderId()).orElseThrow().getStatus());
        assertTrue(courierA.getCourierId() != null && courierB.getCourierId() != null);
    }

    @Test
    void testGetOrchestratorMetricsAndSolverGrpcClientHelpers() {
        Order order = repository.saveNewOrder(createSampleOrder());
        repository.saveCourier(createSampleCourier(List.of()));

        dispatchService.dispatchBatch(
                new DispatchTriggerRequest(order.getHubId(), 10, 0.2),
                "idem-metrics-1",
                "trace-metrics-1");

        TrafficUpdateResponse trafficResp =
                solverClient.updateTrafficMultipliers("batch-traffic-1", 0.65, "trace-traffic-1");
        assertNotNull(trafficResp);
        assertEquals("batch-traffic-1", trafficResp.getBatchId());
        assertNotNull(solverClient.getLastObservedDeadline());
        assertTrue(
                solverClient.getLastObservedDeadline().timeRemaining(TimeUnit.MILLISECONDS)
                        <= SolverGrpcClient.HARD_CLIENT_DEADLINE_MS);

        HealthResponse healthResp = solverClient.checkSolverHealth();
        assertNotNull(healthResp);

        ResponseEntity<OrchestratorMetricsResponse> metricsResp = controller.orchestratorMetrics();
        assertEquals(HttpStatus.OK, metricsResp.getStatusCode());
        OrchestratorMetricsResponse metrics = metricsResp.getBody();
        assertNotNull(metrics);
        assertEquals("UP", metrics.status());
        assertTrue(metrics.virtualThreadsEnabled());
        assertTrue(metrics.activeVirtualThreads() > 0);
        assertEquals(24, metrics.bulkheadMaxPermits());
        assertEquals(24, metrics.bulkheadAvailablePermits());
        assertTrue(metrics.bulkheadTotalAcquisitions() >= 2L);
        assertEquals(SolverGrpcClient.HARD_CLIENT_DEADLINE_MS, metrics.solverDeadlineMs());
        assertTrue(metrics.lastSolveDurationMs() >= 0L);
        assertTrue(metrics.lastObjectiveCost() > 0.0);
        assertTrue(metrics.lastIterationsCompleted() > 0);
        assertTrue(metrics.postgisQueryLatencyMs() >= 0.0);
        assertTrue(metrics.hikariMaxConnections() >= 0);
        assertTrue(metrics.solverWorkers() >= 0);
    }

    private Order createSampleOrder() {
        Instant now = Instant.now();
        return Order.createNew(
                defaultHubId,
                new BigDecimal("3.00"),
                new GeoPoint(1.3521, 103.8198),
                new GeoPoint(1.3621, 103.8298),
                42L,
                now,
                now.plusSeconds(3600),
                240);
    }

    private Courier createSampleCourier(List<UUID> activeRoutes) {
        Instant now = Instant.now();
        return new Courier(
                UUID.randomUUID(),
                "Courier-Alpha",
                activeRoutes.isEmpty() ? CourierStatus.IDLE : CourierStatus.ASSIGNED,
                new BigDecimal("30.00"),
                new BigDecimal("30.00"),
                new GeoPoint(1.3525, 103.8200),
                now,
                now.minusSeconds(1800),
                now.plusSeconds(14400),
                now,
                0,
                activeRoutes,
                activeRoutes.isEmpty() ? "" : "encoded_existing_route");
    }
}
