package com.chronosroute.orchestrator.service;

import com.chronosroute.orchestrator.domain.Courier;
import com.chronosroute.orchestrator.domain.GeoPoint;
import com.chronosroute.orchestrator.domain.IdempotencyRecord;
import com.chronosroute.orchestrator.domain.OptimisticLockConflictException;
import com.chronosroute.orchestrator.domain.Order;
import com.chronosroute.orchestrator.domain.OrderStatus;
import com.chronosroute.orchestrator.domain.OutboxEvent;
import com.chronosroute.orchestrator.dto.OrderDtos.CourierSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.CreateOrderRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchBatchResult;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchTriggerRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.GeoCoordDto;
import com.chronosroute.orchestrator.dto.OrderDtos.HubSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.OrchestratorMetricsResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.OrderResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.OrderSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.ReoptimizeRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.ReoptimizeResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.RouteAssignmentDto;
import com.chronosroute.orchestrator.dto.OrderDtos.RoutePetalDto;
import com.chronosroute.orchestrator.dto.OrderDtos.RouteWaypointDto;
import com.chronosroute.orchestrator.dto.OrderDtos.SnapshotResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.SolveTelemetryDto;
import com.chronosroute.orchestrator.dto.OrderDtos.WebhookStatusUpdateRequest;
import com.chronosroute.orchestrator.grpc.SolverGrpcClient;
import com.chronosroute.orchestrator.repository.DispatchRepository;
import com.chronosroute.proto.v1.CVRPTWResponse;
import com.chronosroute.proto.v1.HealthResponse;
import com.chronosroute.proto.v1.ScheduledStop;
import com.chronosroute.proto.v1.SolverStatus;
import com.chronosroute.proto.v1.VehicleRoute;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Core orchestration service implementing the 3-Phase Dispatch Protocol:
 * <ul>
 *   <li><b>Phase 1 (Short DB Transaction):</b> Acquire {@link VirtualThreadBulkhead} permit, check
 *       {@code Idempotency-Key}, claim {@code PENDING} orders via {@code SKIP LOCKED}, transition
 *       {@code PENDING -> BATCHING}, commit DB transaction, and release permit before network I/O.</li>
 *   <li><b>Phase 2 (Non-Transactional gRPC):</b> Invoke {@code solver-cpp} with {@code 450ms}
 *       deadline and {@code x-trace-id}. On {@code Status.DEADLINE_EXCEEDED}, retain existing courier
 *       routes and release {@code BATCHING} orders back to {@code PENDING}.</li>
 *   <li><b>Phase 3 (Short DB Transaction):</b> Transition assigned orders {@code BATCHING -> ASSIGNED},
 *       update courier capacity with {@code @Version} optimistic locking, write {@code ORDER_ASSIGNED}
 *       events to {@code outbox_events}, and persist {@code idempotency_keys} atomically.</li>
 * </ul>
 */
@Service
public class OrderDispatchService {

    public static final String OUTCOME_ASSIGNED = "ASSIGNED";
    public static final String OUTCOME_NO_PENDING_ORDERS = "NO_PENDING_ORDERS";
    public static final String OUTCOME_DEGRADED_FALLBACK = "DEGRADED_FALLBACK_DEADLINE_EXCEEDED";
    private static final Duration IDEMPOTENCY_TTL = Duration.ofHours(24);

    private final DispatchRepository repository;
    private final VirtualThreadBulkhead bulkhead;
    private final SolverGrpcClient solverClient;
    private final Map<String, DispatchBatchResult> cachedDispatchResults = new ConcurrentHashMap<>();
    private final Map<String, OrderResponse> cachedOrderResponses = new ConcurrentHashMap<>();
    private final AtomicReference<SolveTelemetryDto> latestSolveTelemetry = new AtomicReference<>();
    private final AtomicInteger lastKnownSolverWorkers = new AtomicInteger(0);

    public OrderDispatchService(
            DispatchRepository repository,
            VirtualThreadBulkhead bulkhead,
            SolverGrpcClient solverClient) {
        this.repository = Objects.requireNonNull(repository, "repository must not be null");
        this.bulkhead = Objects.requireNonNull(bulkhead, "bulkhead must not be null");
        this.solverClient = Objects.requireNonNull(solverClient, "solverClient must not be null");
    }

    /**
     * Executes the 3-Phase Dispatch Protocol for a batch of pending orders.
     */
    public DispatchBatchResult dispatchBatch(
            DispatchTriggerRequest triggerRequest, String idempotencyKey, String traceId) {
        Objects.requireNonNull(triggerRequest, "triggerRequest must not be null");
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new IllegalArgumentException("Idempotency-Key header is required for dispatchBatch");
        }
        String effectiveTraceId =
                (traceId == null || traceId.isBlank()) ? "trace-" + UUID.randomUUID() : traceId;

        // =========================================================================
        // PHASE 1: Short Database Transaction (Idempotency Check + SKIP LOCKED Claim)
        // =========================================================================
        Phase1ClaimOutcome phase1 = bulkhead.executeWithPermit(() -> executePhase1Claim(
                triggerRequest.effectiveBatchSize(), idempotencyKey, effectiveTraceId));

        if (phase1.replayedResult() != null) {
            return phase1.replayedResult();
        }

        List<Order> claimedOrders = phase1.claimedOrders();
        List<Courier> availableCouriers = phase1.availableCouriers();
        if (claimedOrders.isEmpty()) {
            return new DispatchBatchResult(
                    "req-" + UUID.randomUUID(),
                    effectiveTraceId,
                    OUTCOME_NO_PENDING_ORDERS,
                    0,
                    List.of(),
                    List.of(),
                    List.of(),
                    countActiveRoutes(availableCouriers),
                    false,
                    false,
                    0L);
        }

        // =========================================================================
        // PHASE 2: Non-Transactional gRPC Call (450ms Hard Deadline)
        // Strict invariant: DB transaction MUST NOT be open during remote gRPC call!
        // =========================================================================
        if (repository.isTransactionActive()) {
            throw new IllegalStateException(
                    "Guardrail violation: database transaction must NOT be open during solver gRPC RPC");
        }

        String requestId = "batch-" + UUID.randomUUID();
        CVRPTWResponse solverResponse;
        try {
            solverResponse = solverClient.solveBatch(
                    requestId, effectiveTraceId, claimedOrders, availableCouriers);
        } catch (StatusRuntimeException rpcEx) {
            if (rpcEx.getStatus().getCode() == Status.Code.DEADLINE_EXCEEDED
                    || rpcEx.getStatus().getCode() == Status.Code.UNAVAILABLE) {
                return handleDeadlineFallback(
                        requestId,
                        effectiveTraceId,
                        idempotencyKey,
                        claimedOrders,
                        availableCouriers);
            }
            releaseOrdersToPendingInShortTx(claimedOrders);
            throw rpcEx;
        }

        if (solverResponse.getStatus() == SolverStatus.SOLVER_STATUS_ERROR
                || solverResponse.getStatus() == SolverStatus.SOLVER_STATUS_INFEASIBLE) {
            return handleDeadlineFallback(
                    requestId, effectiveTraceId, idempotencyKey, claimedOrders, availableCouriers);
        }

        // =========================================================================
        // PHASE 3: Short Database Transaction (State Transitions + @Version + Outbox)
        // =========================================================================
        return bulkhead.executeWithPermit(() -> executePhase3Commit(
                requestId,
                effectiveTraceId,
                idempotencyKey,
                claimedOrders,
                availableCouriers,
                solverResponse));
    }

    @Transactional
    protected Phase1ClaimOutcome executePhase1Claim(
            int batchSize, String idempotencyKey, String traceId) {
        repository.beginTransaction();
        try {
            Optional<IdempotencyRecord> existing = repository.findIdempotencyRecord(idempotencyKey);
            if (existing.isPresent()) {
                DispatchBatchResult cached = cachedDispatchResults.get(idempotencyKey);
                repository.commitTransaction();
                if (cached != null) {
                    return new Phase1ClaimOutcome(
                            new DispatchBatchResult(
                                    cached.requestId(),
                                    traceId,
                                    cached.dispatchOutcome(),
                                    cached.claimedOrderCount(),
                                    cached.assignedOrderIds(),
                                    cached.unassignedOrderIds(),
                                    cached.routes(),
                                    cached.retainedExistingRoutesCount(),
                                    cached.degradedFallback(),
                                    true,
                                    cached.solverDurationMs()),
                            List.of(),
                            List.of());
                }
            }

            List<Order> claimed = repository.claimPendingOrdersSkipLocked(batchSize);
            List<Courier> couriers = repository.findAvailableCouriers(32);
            repository.commitTransaction();
            return new Phase1ClaimOutcome(null, claimed, couriers);
        } catch (RuntimeException ex) {
            repository.rollbackTransaction();
            throw ex;
        }
    }

    @Transactional
    protected DispatchBatchResult handleDeadlineFallback(
            String requestId,
            String traceId,
            String idempotencyKey,
            List<Order> batchingOrders,
            List<Courier> couriers) {
        return bulkhead.executeWithPermit(() -> {
            repository.beginTransaction();
            try {
                List<UUID> releasedIds = new ArrayList<>(batchingOrders.size());
                for (Order order : batchingOrders) {
                    int expectedVer = order.getVersion();
                    Order rollbackCopy = order.copy();
                    rollbackCopy.releaseToPending();
                    repository.updateOrderWithOptimisticLock(rollbackCopy, expectedVer);
                    releasedIds.add(order.getOrderId());
                }

                int retainedRoutesCount = countActiveRoutes(couriers);
                DispatchBatchResult fallbackResult = new DispatchBatchResult(
                        requestId,
                        traceId,
                        OUTCOME_DEGRADED_FALLBACK,
                        batchingOrders.size(),
                        List.of(),
                        releasedIds,
                        List.of(),
                        retainedRoutesCount,
                        true,
                        false,
                        SolverGrpcClient.HARD_CLIENT_DEADLINE_MS);

                Instant now = Instant.now();
                repository.saveIdempotencyRecordIfAbsent(new IdempotencyRecord(
                        idempotencyKey,
                        "DISPATCH_BATCH",
                        requestId,
                        200,
                        "{\"outcome\":\"" + OUTCOME_DEGRADED_FALLBACK + "\"}",
                        now,
                        now.plus(IDEMPOTENCY_TTL),
                        0));
                cachedDispatchResults.put(idempotencyKey, fallbackResult);
                repository.commitTransaction();
                return fallbackResult;
            } catch (RuntimeException ex) {
                repository.rollbackTransaction();
                throw ex;
            }
        });
    }

    @Transactional
    protected void releaseOrdersToPendingInShortTx(List<Order> batchingOrders) {
        bulkhead.executeWithPermit(() -> {
            repository.beginTransaction();
            try {
                for (Order order : batchingOrders) {
                    Order copy = order.copy();
                    copy.releaseToPending();
                    repository.updateOrderWithOptimisticLock(copy, order.getVersion());
                }
                repository.commitTransaction();
                return null;
            } catch (RuntimeException ex) {
                repository.rollbackTransaction();
                throw ex;
            }
        });
    }

    @Transactional
    protected DispatchBatchResult executePhase3Commit(
            String requestId,
            String traceId,
            String idempotencyKey,
            List<Order> claimedOrders,
            List<Courier> availableCouriers,
            CVRPTWResponse solverResponse) {
        repository.beginTransaction();
        try {
            Map<UUID, Order> claimedById = new HashMap<>();
            for (Order o : claimedOrders) {
                claimedById.put(o.getOrderId(), o);
            }
            Map<UUID, Courier> courierById = new HashMap<>();
            for (Courier c : availableCouriers) {
                courierById.put(c.getCourierId(), c);
            }

            List<UUID> assignedOrderIds = new ArrayList<>();
            List<UUID> unassignedOrderIds = new ArrayList<>();
            List<RouteAssignmentDto> routeDtos = new ArrayList<>();
            Set<UUID> handledOrders = new HashSet<>();

            for (VehicleRoute protoRoute : solverResponse.getRoutesList()) {
                UUID courierId = UUID.fromString(protoRoute.getVehicleId());
                Courier courier = courierById.get(courierId);
                if (courier == null) {
                    continue;
                }

                List<Order> routeOrders = new ArrayList<>();
                List<UUID> routeOrderIds = new ArrayList<>();
                Map<UUID, ScheduledStop> stopScheduleByOrder = new HashMap<>();
                BigDecimal totalRouteWeight = BigDecimal.ZERO;

                for (ScheduledStop stop : protoRoute.getScheduledStopsList()) {
                    UUID stopOrderId = UUID.fromString(stop.getStopId());
                    Order claimed = claimedById.get(stopOrderId);
                    if (claimed != null && !handledOrders.contains(stopOrderId)) {
                        routeOrders.add(claimed);
                        routeOrderIds.add(stopOrderId);
                        stopScheduleByOrder.put(stopOrderId, stop);
                        totalRouteWeight = totalRouteWeight.add(claimed.getWeightKg());
                        handledOrders.add(stopOrderId);
                    }
                }

                if (routeOrders.isEmpty()) {
                    continue;
                }

                boolean courierUpdated = false;
                Courier candidateCourier = courier;
                Courier persistedCourier = null;
                for (int attempt = 0; attempt < 20; attempt++) {
                    if (candidateCourier.getCurrentCapacityKg().compareTo(totalRouteWeight) < 0) {
                        break;
                    }
                    try {
                        Courier updatedCourier = candidateCourier.copy();
                        updatedCourier.assignRoute(
                                routeOrderIds, totalRouteWeight, protoRoute.getEncodedPolyline());
                        persistedCourier = repository.updateCourierWithOptimisticLock(
                                updatedCourier, candidateCourier.getVersion());
                        courierUpdated = true;
                        break;
                    } catch (OptimisticLockConflictException conflict) {
                        candidateCourier = repository.findCourierById(courierId).orElse(null);
                        if (candidateCourier == null) {
                            break;
                        }
                    }
                }

                if (courierUpdated) {
                    for (Order order : routeOrders) {
                        Order assignedOrder = order.copy();
                        assignedOrder.assignToCourier(courierId);
                        repository.updateOrderWithOptimisticLock(assignedOrder, order.getVersion());
                        assignedOrderIds.add(order.getOrderId());

                        String payloadJson = String.format(
                                "{\"orderId\":\"%s\",\"courierId\":\"%s\",\"status\":\"ASSIGNED\",\"traceId\":\"%s\"}",
                                order.getOrderId(), courierId, traceId);
                        repository.insertOutboxEvent(OutboxEvent.pending(
                                "ORDER",
                                order.getOrderId().toString(),
                                "ORDER_ASSIGNED",
                                payloadJson));
                    }

                    RoutePetalDto petal = buildRoutePetal(
                            persistedCourier != null ? persistedCourier : candidateCourier,
                            routeOrders,
                            stopScheduleByOrder,
                            protoRoute.getTotalDistanceMeters(),
                            protoRoute.getTotalDurationSeconds(),
                            protoRoute.getEncodedPolyline());
                    repository.saveOrReplaceRoute(petal);

                    routeDtos.add(new RouteAssignmentDto(
                            courierId,
                            routeOrderIds,
                            protoRoute.getTotalDistanceMeters(),
                            protoRoute.getTotalDurationSeconds(),
                            petal.encodedPolyline()));
                } else {
                    // Courier capacity exhausted or optimistic lock retries exceeded; release back to PENDING
                    for (Order order : routeOrders) {
                        Order fallback = order.copy();
                        fallback.releaseToPending();
                        repository.updateOrderWithOptimisticLock(fallback, order.getVersion());
                        unassignedOrderIds.add(order.getOrderId());
                    }
                }
            }

            // Release any unassigned stops back from BATCHING -> PENDING
            for (Order claimed : claimedOrders) {
                if (!assignedOrderIds.contains(claimed.getOrderId())
                        && !unassignedOrderIds.contains(claimed.getOrderId())) {
                    Order released = claimed.copy();
                    released.releaseToPending();
                    repository.updateOrderWithOptimisticLock(released, claimed.getVersion());
                    unassignedOrderIds.add(claimed.getOrderId());
                }
            }

            DispatchBatchResult result = new DispatchBatchResult(
                    requestId,
                    traceId,
                    OUTCOME_ASSIGNED,
                    claimedOrders.size(),
                    assignedOrderIds,
                    unassignedOrderIds,
                    routeDtos,
                    countActiveRoutes(availableCouriers),
                    false,
                    false,
                    solverResponse.getSolverDurationMs());

            Instant now = Instant.now();
            latestSolveTelemetry.set(new SolveTelemetryDto(
                    requestId,
                    solverResponse.getStatus().name(),
                    solverResponse.getSolverDurationMs(),
                    solverClient.getLastMatrixPreprocessMs(),
                    lastKnownSolverWorkers.get(),
                    solverResponse.getObjectiveCost(),
                    solverResponse.getIterationsCompleted(),
                    now));
            repository.saveIdempotencyRecordIfAbsent(new IdempotencyRecord(
                    idempotencyKey,
                    "DISPATCH_BATCH",
                    requestId,
                    200,
                    "{\"outcome\":\"ASSIGNED\",\"assignedCount\":" + assignedOrderIds.size() + "}",
                    now,
                    now.plus(IDEMPOTENCY_TTL),
                    0));
            cachedDispatchResults.put(idempotencyKey, result);
            repository.commitTransaction();
            return result;
        } catch (RuntimeException ex) {
            repository.rollbackTransaction();
            throw ex;
        }
    }

    public OrderResponse createOrder(
            CreateOrderRequest request, String idempotencyKey, String traceId) {
        Objects.requireNonNull(request, "request must not be null");
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new IllegalArgumentException("Idempotency-Key header is required");
        }
        String effectiveTraceId =
                (traceId == null || traceId.isBlank()) ? "trace-" + UUID.randomUUID() : traceId;

        return bulkhead.executeWithPermit(() -> {
            repository.beginTransaction();
            try {
                Optional<IdempotencyRecord> existing =
                        repository.findIdempotencyRecord(idempotencyKey);
                if (existing.isPresent()) {
                    OrderResponse cached = cachedOrderResponses.get(idempotencyKey);
                    repository.commitTransaction();
                    if (cached != null) {
                        return new OrderResponse(
                                cached.orderId(),
                                cached.hubId(),
                                cached.courierId(),
                                cached.status(),
                                cached.weightKg(),
                                cached.pickupLat(),
                                cached.pickupLon(),
                                cached.dropoffLat(),
                                cached.dropoffLon(),
                                cached.version(),
                                true,
                                effectiveTraceId);
                    }
                }

                Order newOrder = Order.createNew(
                        request.hubId(),
                        request.weightKg(),
                        new GeoPoint(request.pickupLat(), request.pickupLon()),
                        new GeoPoint(request.dropoffLat(), request.dropoffLon()),
                        request.dropoffNode(),
                        request.windowStart(),
                        request.windowEnd(),
                        request.serviceDurationSeconds());

                Order saved = repository.saveNewOrder(newOrder);
                repository.insertOutboxEvent(OutboxEvent.pending(
                        "ORDER",
                        saved.getOrderId().toString(),
                        "ORDER_CREATED",
                        "{\"orderId\":\"" + saved.getOrderId() + "\",\"status\":\"PENDING\"}"));

                OrderResponse response = toOrderResponse(saved, false, effectiveTraceId);
                Instant now = Instant.now();
                repository.saveIdempotencyRecordIfAbsent(new IdempotencyRecord(
                        idempotencyKey,
                        "ORDER",
                        saved.getOrderId().toString(),
                        201,
                        "{\"orderId\":\"" + saved.getOrderId() + "\"}",
                        now,
                        now.plus(IDEMPOTENCY_TTL),
                        0));
                cachedOrderResponses.put(idempotencyKey, response);
                repository.commitTransaction();
                return response;
            } catch (RuntimeException ex) {
                repository.rollbackTransaction();
                throw ex;
            }
        });
    }

    public OrderResponse transitionOrderStatus(
            UUID orderId,
            WebhookStatusUpdateRequest updateRequest,
            String idempotencyKey,
            String traceId) {
        Objects.requireNonNull(orderId, "orderId must not be null");
        Objects.requireNonNull(updateRequest, "updateRequest must not be null");
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new IllegalArgumentException("Idempotency-Key header is required");
        }
        String effectiveTraceId =
                (traceId == null || traceId.isBlank()) ? "trace-" + UUID.randomUUID() : traceId;

        return bulkhead.executeWithPermit(() -> {
            repository.beginTransaction();
            try {
                Optional<IdempotencyRecord> existing =
                        repository.findIdempotencyRecord(idempotencyKey);
                if (existing.isPresent()) {
                    OrderResponse cached = cachedOrderResponses.get(idempotencyKey);
                    repository.commitTransaction();
                    if (cached != null) {
                        return new OrderResponse(
                                cached.orderId(),
                                cached.hubId(),
                                cached.courierId(),
                                cached.status(),
                                cached.weightKg(),
                                cached.pickupLat(),
                                cached.pickupLon(),
                                cached.dropoffLat(),
                                cached.dropoffLon(),
                                cached.version(),
                                true,
                                effectiveTraceId);
                    }
                }

                Order order = repository.findOrderById(orderId)
                        .orElseThrow(() -> new IllegalArgumentException("Order not found: " + orderId));
                order.transitionTo(updateRequest.targetStatus());
                Order saved = repository.updateOrderWithOptimisticLock(
                        order, updateRequest.expectedVersion());

                repository.insertOutboxEvent(OutboxEvent.pending(
                        "ORDER",
                        saved.getOrderId().toString(),
                        "ORDER_" + saved.getStatus().name(),
                        "{\"orderId\":\"" + saved.getOrderId()
                                + "\",\"status\":\"" + saved.getStatus().name() + "\"}"));

                OrderResponse response = toOrderResponse(saved, false, effectiveTraceId);
                Instant now = Instant.now();
                repository.saveIdempotencyRecordIfAbsent(new IdempotencyRecord(
                        idempotencyKey,
                        "ORDER",
                        saved.getOrderId().toString(),
                        200,
                        "{\"orderId\":\"" + saved.getOrderId()
                                + "\",\"status\":\"" + saved.getStatus().name() + "\"}",
                        now,
                        now.plus(IDEMPOTENCY_TTL),
                        0));
                cachedOrderResponses.put(idempotencyKey, response);
                repository.commitTransaction();
                return response;
            } catch (RuntimeException ex) {
                repository.rollbackTransaction();
                throw ex;
            }
        });
    }

    public SnapshotResponse getSnapshot() {
        return getSnapshot(200);
    }

    public SnapshotResponse getSnapshot(int limit) {
        int effectiveLimit = limit <= 0 ? 200 : Math.min(limit, 1000);
        List<HubSnapshotDto> hubs = repository.findSnapshotHubs();
        Map<String, Object> zonesGeoJson = repository.findHubServiceZonesGeoJson();
        List<CourierSnapshotDto> couriers = repository.findSnapshotCouriers(effectiveLimit);
        List<OrderSnapshotDto> orders = repository.findSnapshotOrders(effectiveLimit);
        List<RoutePetalDto> routes = repository.getActiveRoutePetals();

        GeoCoordDto regionCenter = computeRegionCenter(hubs, couriers, orders);
        SolveTelemetryDto latestSolve = getLatestSolveTelemetry();
        return new SnapshotResponse(
                Instant.now(),
                regionCenter,
                hubs,
                zonesGeoJson,
                couriers,
                orders,
                routes,
                latestSolve);
    }

    public ReoptimizeResponse reoptimize(ReoptimizeRequest request) {
        return reoptimize(request, "reopt-" + UUID.randomUUID(), "trace-" + UUID.randomUUID());
    }

    public ReoptimizeResponse reoptimize(
            ReoptimizeRequest request, String idempotencyKey, String traceId) {
        ReoptimizeRequest effectiveReq =
                request != null ? request : new ReoptimizeRequest(null, 50, 0.0, null);
        int batchSize = (effectiveReq.batchSize() == null || effectiveReq.batchSize() <= 0)
                ? 50
                : Math.min(effectiveReq.batchSize(), 200);
        double weatherSeverity =
                effectiveReq.weatherSeverityScore() != null
                        ? effectiveReq.weatherSeverityScore()
                        : 0.0;
        String effectiveKey = (idempotencyKey == null || idempotencyKey.isBlank())
                ? "reopt-" + UUID.randomUUID()
                : idempotencyKey;
        String effectiveTraceId = (traceId == null || traceId.isBlank())
                ? "trace-" + UUID.randomUUID()
                : traceId;

        List<RoutePetalDto> beforeRoutes = repository.getActiveRoutePetals();
        long beforeTotalDistance =
                beforeRoutes.stream().mapToLong(RoutePetalDto::totalDistanceMeters).sum();
        int beforeViolations = countTimeWindowViolations(beforeRoutes);
        Map<UUID, UUID> beforeOrderCourier = new HashMap<>();
        for (RoutePetalDto petal : beforeRoutes) {
            for (RouteWaypointDto wp : petal.waypoints()) {
                beforeOrderCourier.put(wp.orderId(), petal.courierId());
            }
        }

        // Non-transactional traffic speed update to solver-cpp before solving
        if (effectiveReq.speedMultiplier() != null) {
            solverClient.updateTrafficMultipliers(
                    effectiveKey, effectiveReq.speedMultiplier(), effectiveTraceId);
        }

        DispatchBatchResult batchResult = dispatchBatch(
                new DispatchTriggerRequest(effectiveReq.hubId(), batchSize, weatherSeverity),
                effectiveKey,
                effectiveTraceId);

        if (OUTCOME_NO_PENDING_ORDERS.equals(batchResult.dispatchOutcome())) {
            DispatchBatchResult reoptAssigned = reoptimizeExistingAssignedRoutes(
                    effectiveReq.hubId(), batchSize, effectiveTraceId, beforeRoutes);
            if (reoptAssigned != null) {
                batchResult = reoptAssigned;
            }
        }

        List<RoutePetalDto> afterRoutes = repository.getActiveRoutePetals();
        long afterTotalDistance =
                afterRoutes.stream().mapToLong(RoutePetalDto::totalDistanceMeters).sum();
        int afterViolations = countTimeWindowViolations(afterRoutes);

        List<UUID> reassignedOrderIds = new ArrayList<>();
        Set<UUID> seenOrderIds = new HashSet<>();
        for (RoutePetalDto petal : afterRoutes) {
            for (RouteWaypointDto wp : petal.waypoints()) {
                UUID prevCourier = beforeOrderCourier.get(wp.orderId());
                if (!petal.courierId().equals(prevCourier) && seenOrderIds.add(wp.orderId())) {
                    reassignedOrderIds.add(wp.orderId());
                }
            }
        }
        if (reassignedOrderIds.isEmpty() && !batchResult.assignedOrderIds().isEmpty()) {
            reassignedOrderIds.addAll(batchResult.assignedOrderIds());
        }

        long distanceSavedMeters = beforeRoutes.isEmpty()
                ? 0L
                : Math.max(0L, beforeTotalDistance - afterTotalDistance);
        int resolvedViolations = Math.max(0, beforeViolations - afterViolations);
        SolveTelemetryDto telemetry = getLatestSolveTelemetry();

        return new ReoptimizeResponse(
                batchResult,
                beforeRoutes,
                afterRoutes,
                distanceSavedMeters,
                resolvedViolations,
                reassignedOrderIds,
                telemetry);
    }

    public OrchestratorMetricsResponse getOrchestratorMetrics() {
        int hikariActive = 0;
        int hikariIdle = 0;
        int hikariMax = 0;
        DataSource ds = repository.getDataSource();
        if (ds instanceof HikariDataSource hikari) {
            hikariMax = hikari.getMaximumPoolSize();
            HikariPoolMXBean mxBean = hikari.getHikariPoolMXBean();
            if (mxBean != null) {
                hikariActive = mxBean.getActiveConnections();
                hikariIdle = mxBean.getIdleConnections();
            }
        }

        int activeThreads = Thread.getAllStackTraces().size();
        double postgisLatencyMs = repository.measurePostgisLatencyMs();
        HealthResponse solverHealth = solverClient.checkSolverHealth();
        int solverWorkers = solverHealth.getHealthy() ? solverHealth.getActiveWorkers() : 0;
        lastKnownSolverWorkers.set(solverWorkers);

        SolveTelemetryDto latest = latestSolveTelemetry.get();
        long lastSolveMs = latest != null ? latest.solveDurationMs() : 0L;
        long lastMatrixMs = latest != null ? latest.matrixPreprocessMs() : 0L;
        double lastCost = latest != null ? latest.objectiveCost() : 0.0;
        int lastIters = latest != null ? latest.iterationsCompleted() : 0;

        return new OrchestratorMetricsResponse(
                "UP",
                true,
                activeThreads,
                bulkhead.getMaxPermits(),
                bulkhead.getAvailablePermits(),
                bulkhead.getTotalAcquisitions(),
                bulkhead.getPeakConcurrentHolders(),
                hikariActive,
                hikariIdle,
                hikariMax,
                postgisLatencyMs,
                SolverGrpcClient.HARD_CLIENT_DEADLINE_MS,
                lastSolveMs,
                lastMatrixMs,
                lastCost,
                lastIters,
                solverWorkers);
    }

    public void clearCachedSeedState() {
        cachedDispatchResults.clear();
        cachedOrderResponses.clear();
        latestSolveTelemetry.set(null);
        repository.clearCachedSeedState();
    }

    private SolveTelemetryDto getLatestSolveTelemetry() {
        SolveTelemetryDto current = latestSolveTelemetry.get();
        if (current != null) {
            return current;
        }
        return new SolveTelemetryDto(
                "initial",
                "IDLE",
                0L,
                0L,
                lastKnownSolverWorkers.get(),
                0.0,
                0,
                Instant.now());
    }

    private DispatchBatchResult reoptimizeExistingAssignedRoutes(
            UUID hubId, int batchSize, String traceId, List<RoutePetalDto> beforeRoutes) {
        Phase1ClaimOutcome phase1 = bulkhead.executeWithPermit(() -> {
            repository.beginTransaction();
            try {
                List<Order> assigned = repository.findAssignedOrders(hubId, batchSize);
                List<Courier> couriers = repository.findAvailableCouriers(32);
                repository.commitTransaction();
                return new Phase1ClaimOutcome(null, assigned, couriers);
            } catch (RuntimeException ex) {
                repository.rollbackTransaction();
                throw ex;
            }
        });

        List<Order> assignedOrders = phase1.claimedOrders();
        List<Courier> availableCouriers = phase1.availableCouriers();
        if (assignedOrders.isEmpty() || availableCouriers.isEmpty()) {
            return null;
        }

        if (repository.isTransactionActive()) {
            throw new IllegalStateException(
                    "Guardrail violation: database transaction must NOT be open during solver gRPC RPC");
        }

        // Compute free capacity per courier if their existing ASSIGNED stops are re-planned
        Map<UUID, BigDecimal> assignedWeightByCourier = new HashMap<>();
        for (Order o : assignedOrders) {
            if (o.getCourierId() != null) {
                assignedWeightByCourier.merge(o.getCourierId(), o.getWeightKg(), BigDecimal::add);
            }
        }
        List<Courier> solverCouriers = new ArrayList<>(availableCouriers.size());
        for (Courier c : availableCouriers) {
            BigDecimal addBack = assignedWeightByCourier.getOrDefault(c.getCourierId(), BigDecimal.ZERO);
            BigDecimal restored = c.getCurrentCapacityKg().add(addBack);
            if (restored.compareTo(c.getMaxCapacityKg()) > 0) {
                restored = c.getMaxCapacityKg();
            }
            solverCouriers.add(new Courier(
                    c.getCourierId(),
                    c.getName(),
                    c.getStatus(),
                    restored,
                    c.getMaxCapacityKg(),
                    c.getLastLocation(),
                    c.getLastPingAt(),
                    c.getShiftStart(),
                    c.getShiftEnd(),
                    c.getCreatedAt(),
                    c.getVersion(),
                    c.getActiveRouteOrderIds(),
                    c.getActiveEncodedPolyline()));
        }

        String requestId = "reopt-" + UUID.randomUUID();
        CVRPTWResponse solverResponse;
        try {
            solverResponse = solverClient.solveBatch(
                    requestId, traceId, assignedOrders, solverCouriers);
        } catch (StatusRuntimeException rpcEx) {
            if (rpcEx.getStatus().getCode() == Status.Code.DEADLINE_EXCEEDED
                    || rpcEx.getStatus().getCode() == Status.Code.UNAVAILABLE) {
                return new DispatchBatchResult(
                        requestId,
                        traceId,
                        OUTCOME_DEGRADED_FALLBACK,
                        assignedOrders.size(),
                        List.of(),
                        List.of(),
                        List.of(),
                        beforeRoutes.size(),
                        true,
                        false,
                        SolverGrpcClient.HARD_CLIENT_DEADLINE_MS);
            }
            throw rpcEx;
        }

        if (solverResponse.getStatus() == SolverStatus.SOLVER_STATUS_ERROR
                || solverResponse.getStatus() == SolverStatus.SOLVER_STATUS_INFEASIBLE) {
            return new DispatchBatchResult(
                    requestId,
                    traceId,
                    OUTCOME_DEGRADED_FALLBACK,
                    assignedOrders.size(),
                    List.of(),
                    List.of(),
                    List.of(),
                    beforeRoutes.size(),
                    true,
                    false,
                    solverResponse.getSolverDurationMs());
        }

        return bulkhead.executeWithPermit(() -> {
            repository.beginTransaction();
            try {
                Map<UUID, Order> ordersById = new HashMap<>();
                for (Order o : assignedOrders) {
                    ordersById.put(o.getOrderId(), o);
                }
                Map<UUID, Courier> couriersById = new HashMap<>();
                for (Courier c : availableCouriers) {
                    couriersById.put(c.getCourierId(), c);
                }

                List<UUID> assignedOrderIds = new ArrayList<>();
                List<UUID> unassignedOrderIds = new ArrayList<>();
                List<RouteAssignmentDto> routeDtos = new ArrayList<>();
                Set<UUID> handledOrders = new HashSet<>();
                Set<UUID> activeRouteCouriers = new HashSet<>();

                for (VehicleRoute protoRoute : solverResponse.getRoutesList()) {
                    UUID courierId = UUID.fromString(protoRoute.getVehicleId());
                    Courier courier = couriersById.get(courierId);
                    if (courier == null) {
                        continue;
                    }

                    List<Order> routeOrders = new ArrayList<>();
                    List<UUID> routeOrderIds = new ArrayList<>();
                    Map<UUID, ScheduledStop> stopScheduleByOrder = new HashMap<>();
                    BigDecimal totalRouteWeight = BigDecimal.ZERO;

                    for (ScheduledStop stop : protoRoute.getScheduledStopsList()) {
                        UUID stopOrderId = UUID.fromString(stop.getStopId());
                        Order ord = ordersById.get(stopOrderId);
                        if (ord != null && !handledOrders.contains(stopOrderId)) {
                            routeOrders.add(ord);
                            routeOrderIds.add(stopOrderId);
                            stopScheduleByOrder.put(stopOrderId, stop);
                            totalRouteWeight = totalRouteWeight.add(ord.getWeightKg());
                            handledOrders.add(stopOrderId);
                        }
                    }

                    if (routeOrders.isEmpty()
                            || courier.getMaxCapacityKg().compareTo(totalRouteWeight) < 0) {
                        continue;
                    }

                    Courier updatedCourier = courier.copy();
                    updatedCourier.replaceRoute(
                            routeOrderIds, totalRouteWeight, protoRoute.getEncodedPolyline());
                    Courier persistedCourier = repository.updateCourierWithOptimisticLock(
                            updatedCourier, courier.getVersion());
                    activeRouteCouriers.add(courierId);

                    for (Order order : routeOrders) {
                        if (!courierId.equals(order.getCourierId())) {
                            Order reassigned = order.copy();
                            reassigned.reassignCourier(courierId);
                            repository.updateOrderWithOptimisticLock(reassigned, order.getVersion());
                        }
                        assignedOrderIds.add(order.getOrderId());
                        repository.insertOutboxEvent(OutboxEvent.pending(
                                "ORDER",
                                order.getOrderId().toString(),
                                "ROUTES_REOPTIMIZED",
                                String.format(
                                        "{\"orderId\":\"%s\",\"courierId\":\"%s\",\"traceId\":\"%s\"}",
                                        order.getOrderId(), courierId, traceId)));
                    }

                    RoutePetalDto petal = buildRoutePetal(
                            persistedCourier,
                            routeOrders,
                            stopScheduleByOrder,
                            protoRoute.getTotalDistanceMeters(),
                            protoRoute.getTotalDurationSeconds(),
                            protoRoute.getEncodedPolyline());
                    repository.saveOrReplaceRoute(petal);

                    routeDtos.add(new RouteAssignmentDto(
                            courierId,
                            routeOrderIds,
                            protoRoute.getTotalDistanceMeters(),
                            protoRoute.getTotalDurationSeconds(),
                            petal.encodedPolyline()));
                }

                for (Courier courier : availableCouriers) {
                    if (!activeRouteCouriers.contains(courier.getCourierId())
                            && !courier.getActiveRouteOrderIds().isEmpty()) {
                        Courier cleared = courier.copy();
                        cleared.replaceRoute(List.of(), BigDecimal.ZERO, "");
                        repository.updateCourierWithOptimisticLock(cleared, courier.getVersion());
                        repository.deleteRouteForCourier(courier.getCourierId());
                    }
                }

                for (Order o : assignedOrders) {
                    if (!assignedOrderIds.contains(o.getOrderId())) {
                        unassignedOrderIds.add(o.getOrderId());
                    }
                }

                latestSolveTelemetry.set(new SolveTelemetryDto(
                        requestId,
                        solverResponse.getStatus().name(),
                        solverResponse.getSolverDurationMs(),
                        solverClient.getLastMatrixPreprocessMs(),
                        lastKnownSolverWorkers.get(),
                        solverResponse.getObjectiveCost(),
                        solverResponse.getIterationsCompleted(),
                        Instant.now()));

                repository.commitTransaction();
                return new DispatchBatchResult(
                        requestId,
                        traceId,
                        OUTCOME_ASSIGNED,
                        assignedOrders.size(),
                        assignedOrderIds,
                        unassignedOrderIds,
                        routeDtos,
                        routeDtos.size(),
                        false,
                        false,
                        solverResponse.getSolverDurationMs());
            } catch (RuntimeException ex) {
                repository.rollbackTransaction();
                throw ex;
            }
        });
    }

    private static RoutePetalDto buildRoutePetal(
            Courier courier,
            List<Order> routeOrders,
            Map<UUID, ScheduledStop> stopScheduleByOrder,
            long totalDistanceMeters,
            long totalDurationSeconds,
            String rawEncodedPolyline) {
        List<RouteWaypointDto> waypoints = new ArrayList<>(routeOrders.size());
        double startLat = courier.getLastLocation().latitude();
        double startLon = courier.getLastLocation().longitude();
        if (startLat == 0.0 && startLon == 0.0 && !routeOrders.isEmpty()) {
            startLat = routeOrders.get(0).getPickupLocation().latitude();
            startLon = routeOrders.get(0).getPickupLocation().longitude();
        }

        List<List<Double>> pathCoords = new ArrayList<>(routeOrders.size() + 1);
        pathCoords.add(List.of(startLon, startLat));

        double capacityUsedKg = 0.0;
        long runningLoadKg = 0L;
        for (Order order : routeOrders) {
            ScheduledStop sched = stopScheduleByOrder.get(order.getOrderId());
            long wStart = order.getWindowStart().getEpochSecond();
            long wEnd = order.getWindowEnd().getEpochSecond();
            long arr = sched != null ? sched.getEstimatedArrivalUnix() : wStart;
            long dep = sched != null
                    ? sched.getEstimatedDepartureUnix()
                    : arr + order.getServiceDurationSeconds();
            long slack = sched != null ? sched.getSlackSeconds() : Math.max(0L, wEnd - arr);
            runningLoadKg += Math.max(1L, order.getWeightKg().longValue());
            long accLoad = sched != null && sched.getAccumulatedLoadKg() > 0
                    ? sched.getAccumulatedLoadKg()
                    : runningLoadKg;
            capacityUsedKg += order.getWeightKg().doubleValue();

            double wpLat = order.getDropoffLocation().latitude();
            double wpLon = order.getDropoffLocation().longitude();
            waypoints.add(new RouteWaypointDto(
                    order.getOrderId(),
                    wpLat,
                    wpLon,
                    arr,
                    dep,
                    slack,
                    accLoad,
                    order.getWeightKg(),
                    wStart,
                    wEnd));
            pathCoords.add(List.of(wpLon, wpLat));
        }

        List<List<Double>> effectivePathCoords = pathCoords;
        String encoded;
        if (rawEncodedPolyline != null && !rawEncodedPolyline.isBlank()) {
            List<List<Double>> decoded = decodePolyline(rawEncodedPolyline);
            if (decoded.size() >= 2) {
                effectivePathCoords = decoded;
            }
            encoded = rawEncodedPolyline;
        } else {
            encoded = encodePolyline(pathCoords);
        }
        UUID hubId = routeOrders.isEmpty() ? null : routeOrders.get(0).getHubId();

        return new RoutePetalDto(
                courier.getCourierId(),
                hubId,
                courier.getName(),
                totalDistanceMeters,
                totalDurationSeconds,
                capacityUsedKg,
                courier.getMaxCapacityKg().doubleValue(),
                encoded,
                waypoints,
                effectivePathCoords);
    }

    private static GeoCoordDto computeRegionCenter(
            List<HubSnapshotDto> hubs,
            List<CourierSnapshotDto> couriers,
            List<OrderSnapshotDto> orders) {
        if (!hubs.isEmpty()) {
            double latSum = 0.0;
            double lonSum = 0.0;
            for (HubSnapshotDto h : hubs) {
                latSum += h.lat();
                lonSum += h.lon();
            }
            return new GeoCoordDto(latSum / hubs.size(), lonSum / hubs.size());
        }
        if (!couriers.isEmpty()) {
            double latSum = 0.0;
            double lonSum = 0.0;
            for (CourierSnapshotDto c : couriers) {
                latSum += c.lat();
                lonSum += c.lon();
            }
            return new GeoCoordDto(latSum / couriers.size(), lonSum / couriers.size());
        }
        if (!orders.isEmpty()) {
            double latSum = 0.0;
            double lonSum = 0.0;
            for (OrderSnapshotDto o : orders) {
                latSum += o.pickupLat();
                lonSum += o.pickupLon();
            }
            return new GeoCoordDto(latSum / orders.size(), lonSum / orders.size());
        }
        return new GeoCoordDto(51.5074, -0.1278);
    }

    private static int countTimeWindowViolations(List<RoutePetalDto> routes) {
        int violations = 0;
        for (RoutePetalDto route : routes) {
            for (RouteWaypointDto wp : route.waypoints()) {
                if (wp.windowEndUnix() > 0 && wp.arrivalUnix() > wp.windowEndUnix()) {
                    violations++;
                }
            }
        }
        return violations;
    }

    public static List<List<Double>> decodePolyline(String encoded) {
        List<List<Double>> coords = new ArrayList<>();
        if (encoded == null || encoded.isBlank()) {
            return coords;
        }
        int index = 0;
        int len = encoded.length();
        long lat = 0;
        long lon = 0;
        while (index < len) {
            int shift = 0;
            long result = 0;
            int b;
            do {
                if (index >= len) {
                    return coords;
                }
                b = encoded.charAt(index++) - 63;
                result |= (long) (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20);
            lat += ((result & 1L) != 0L) ? ~(result >> 1) : (result >> 1);

            shift = 0;
            result = 0;
            do {
                if (index >= len) {
                    return coords;
                }
                b = encoded.charAt(index++) - 63;
                result |= (long) (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20);
            lon += ((result & 1L) != 0L) ? ~(result >> 1) : (result >> 1);

            double latDeg = lat / 1e5;
            double lonDeg = lon / 1e5;
            if (latDeg >= -90.0 && latDeg <= 90.0 && lonDeg >= -180.0 && lonDeg <= 180.0) {
                coords.add(List.of(lonDeg, latDeg));
            }
        }
        return coords;
    }

    private static String encodePolyline(List<List<Double>> pathCoords) {
        if (pathCoords == null || pathCoords.isEmpty()) {
            return "";
        }
        StringBuilder encoded = new StringBuilder();
        long prevLat = 0;
        long prevLon = 0;
        for (List<Double> pt : pathCoords) {
            if (pt == null || pt.size() < 2) {
                continue;
            }
            long lonE5 = Math.round(pt.get(0) * 1e5);
            long latE5 = Math.round(pt.get(1) * 1e5);
            encodeSignedValue(latE5 - prevLat, encoded);
            encodeSignedValue(lonE5 - prevLon, encoded);
            prevLat = latE5;
            prevLon = lonE5;
        }
        return encoded.toString();
    }

    private static void encodeSignedValue(long v, StringBuilder out) {
        long sgn = v < 0 ? ~(v << 1) : (v << 1);
        while (sgn >= 0x20) {
            out.append((char) ((0x20 | (sgn & 0x1f)) + 63));
            sgn >>= 5;
        }
        out.append((char) (sgn + 63));
    }

    private static int countActiveRoutes(List<Courier> couriers) {
        int count = 0;
        for (Courier courier : couriers) {
            if (!courier.getActiveRouteOrderIds().isEmpty()) {
                count++;
            }
        }
        return count;
    }

    private static OrderResponse toOrderResponse(
            Order order, boolean replayed, String traceId) {
        return new OrderResponse(
                order.getOrderId(),
                order.getHubId(),
                order.getCourierId(),
                order.getStatus(),
                order.getWeightKg(),
                order.getPickupLocation().latitude(),
                order.getPickupLocation().longitude(),
                order.getDropoffLocation().latitude(),
                order.getDropoffLocation().longitude(),
                order.getVersion(),
                replayed,
                traceId);
    }

    private record Phase1ClaimOutcome(
            DispatchBatchResult replayedResult,
            List<Order> claimedOrders,
            List<Courier> availableCouriers) {}
}
