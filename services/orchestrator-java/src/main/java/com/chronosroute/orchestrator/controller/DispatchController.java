package com.chronosroute.orchestrator.controller;

import com.chronosroute.orchestrator.domain.IllegalStateTransitionException;
import com.chronosroute.orchestrator.domain.OptimisticLockConflictException;
import com.chronosroute.orchestrator.dto.OrderDtos.CreateOrderRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchBatchResult;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchTriggerRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.OrchestratorHealthResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.OrchestratorMetricsResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.OrderResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.ReoptimizeRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.ReoptimizeResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.SnapshotResponse;
import com.chronosroute.orchestrator.dto.OrderDtos.WebhookStatusUpdateRequest;
import com.chronosroute.orchestrator.grpc.SolverGrpcClient;
import com.chronosroute.orchestrator.service.OrderDispatchService;
import com.chronosroute.orchestrator.service.VirtualThreadBulkhead;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * REST Controller for order ingestion, rolling-horizon dispatch triggers, and courier status
 * webhooks. Requires {@code Idempotency-Key} and propagates {@code x-trace-id}.
 */
@RestController
@RequestMapping("/api/v1")
public class DispatchController {

    private final OrderDispatchService dispatchService;
    private final VirtualThreadBulkhead bulkhead;

    public DispatchController(
            OrderDispatchService dispatchService, VirtualThreadBulkhead bulkhead) {
        this.dispatchService = Objects.requireNonNull(dispatchService, "dispatchService must not be null");
        this.bulkhead = Objects.requireNonNull(bulkhead, "bulkhead must not be null");
    }

    @PostMapping("/orders")
    public ResponseEntity<OrderResponse> createOrder(
            @RequestBody CreateOrderRequest request,
            @RequestHeader(name = "Idempotency-Key") String idempotencyKey,
            @RequestHeader(name = "x-trace-id", required = false) String traceId) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return new ResponseEntity<>(null, HttpStatus.BAD_REQUEST);
        }
        OrderResponse response = dispatchService.createOrder(request, idempotencyKey, traceId);
        HttpStatus status = response.replayedFromIdempotency() ? HttpStatus.OK : HttpStatus.CREATED;
        return new ResponseEntity<>(response, status);
    }

    @PostMapping("/dispatch/trigger")
    public ResponseEntity<DispatchBatchResult> triggerDispatch(
            @RequestBody DispatchTriggerRequest request,
            @RequestHeader(name = "Idempotency-Key") String idempotencyKey,
            @RequestHeader(name = "x-trace-id", required = false) String traceId) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return new ResponseEntity<>(null, HttpStatus.BAD_REQUEST);
        }
        DispatchBatchResult result = dispatchService.dispatchBatch(request, idempotencyKey, traceId);
        return ResponseEntity.ok(result);
    }

    @PatchMapping("/orders/{orderId}/status")
    public ResponseEntity<OrderResponse> updateOrderStatus(
            @PathVariable("orderId") UUID orderId,
            @RequestBody WebhookStatusUpdateRequest request,
            @RequestHeader(name = "Idempotency-Key") String idempotencyKey,
            @RequestHeader(name = "x-trace-id", required = false) String traceId) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return new ResponseEntity<>(null, HttpStatus.BAD_REQUEST);
        }
        try {
            OrderResponse updated = dispatchService.transitionOrderStatus(
                    orderId, request, idempotencyKey, traceId);
            return ResponseEntity.ok(updated);
        } catch (IllegalStateTransitionException | OptimisticLockConflictException conflictEx) {
            return new ResponseEntity<>(null, HttpStatus.CONFLICT);
        }
    }

    @GetMapping("/health")
    public ResponseEntity<OrchestratorHealthResponse> health() {
        OrchestratorHealthResponse snapshot = new OrchestratorHealthResponse(
                "UP",
                true,
                bulkhead.getMaxPermits(),
                bulkhead.getAvailablePermits(),
                bulkhead.getTotalAcquisitions(),
                bulkhead.getPeakConcurrentHolders(),
                SolverGrpcClient.HARD_CLIENT_DEADLINE_MS);
        return ResponseEntity.ok(snapshot);
    }

    @GetMapping("/snapshot")
    public ResponseEntity<SnapshotResponse> snapshot(
            @RequestParam(name = "limit", defaultValue = "200") int limit) {
        return ResponseEntity.ok(dispatchService.getSnapshot(limit));
    }

    @PostMapping("/dispatch/reoptimize")
    public ResponseEntity<ReoptimizeResponse> reoptimize(
            @RequestBody(required = false) ReoptimizeRequest request,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestHeader(name = "x-trace-id", required = false) String traceId) {
        String effectiveKey = (idempotencyKey == null || idempotencyKey.isBlank())
                ? "reopt-" + UUID.randomUUID()
                : idempotencyKey;
        ReoptimizeRequest effectiveRequest =
                request != null ? request : new ReoptimizeRequest(null, 50, 0.0, null);
        return ResponseEntity.ok(dispatchService.reoptimize(effectiveRequest, effectiveKey, traceId));
    }

    @GetMapping("/orchestrator/metrics")
    public ResponseEntity<OrchestratorMetricsResponse> orchestratorMetrics() {
        return ResponseEntity.ok(dispatchService.getOrchestratorMetrics());
    }
}
