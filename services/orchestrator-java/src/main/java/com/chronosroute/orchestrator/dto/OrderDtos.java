package com.chronosroute.orchestrator.dto;

import com.chronosroute.orchestrator.domain.CourierStatus;
import com.chronosroute.orchestrator.domain.OrderStatus;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Immutable Java 21 {@code record} DTOs for REST API requests, dispatch batch outcomes,
 * webhook status transitions, and health/metrics snapshots.
 */
public final class OrderDtos {
    private OrderDtos() {}

    public record CreateOrderRequest(
            UUID hubId,
            BigDecimal weightKg,
            double pickupLat,
            double pickupLon,
            double dropoffLat,
            double dropoffLon,
            long dropoffNode,
            Instant windowStart,
            Instant windowEnd,
            int serviceDurationSeconds) {}

    public record OrderResponse(
            UUID orderId,
            UUID hubId,
            UUID courierId,
            OrderStatus status,
            BigDecimal weightKg,
            double pickupLat,
            double pickupLon,
            double dropoffLat,
            double dropoffLon,
            int version,
            boolean replayedFromIdempotency,
            String traceId) {}

    public record DispatchTriggerRequest(
            UUID hubId,
            int batchSize,
            double weatherSeverityScore) {
        public int effectiveBatchSize() {
            return batchSize <= 0 ? 50 : Math.min(batchSize, 200);
        }
    }

    public record RouteAssignmentDto(
            UUID courierId,
            List<UUID> assignedOrderIds,
            long totalDistanceMeters,
            long totalDurationSeconds,
            String encodedPolyline) {}

    public record DispatchBatchResult(
            String requestId,
            String traceId,
            String dispatchOutcome,
            int claimedOrderCount,
            List<UUID> assignedOrderIds,
            List<UUID> unassignedOrderIds,
            List<RouteAssignmentDto> routes,
            int retainedExistingRoutesCount,
            boolean degradedFallback,
            boolean replayedFromIdempotency,
            long solverDurationMs) {}

    public record WebhookStatusUpdateRequest(
            OrderStatus targetStatus,
            int expectedVersion,
            String reason) {}

    public record OrchestratorHealthResponse(
            String status,
            boolean virtualThreadsEnabled,
            int bulkheadMaxPermits,
            int bulkheadAvailablePermits,
            long bulkheadTotalAcquisitions,
            int peakConcurrentBatchHolders,
            long solverDeadlineMs) {}

    public record GeoCoordDto(double lat, double lon) {}

    public record HubSnapshotDto(
            UUID hubId,
            String name,
            double lat,
            double lon,
            int capacityOrdersPerHour) {}

    public record CourierSnapshotDto(
            UUID courierId,
            String name,
            CourierStatus status,
            double lat,
            double lon,
            double headingDeg,
            double speedMps,
            int batteryPct,
            BigDecimal currentCapacityKg,
            BigDecimal maxCapacityKg,
            Instant lastPingAt,
            Instant shiftStart,
            Instant shiftEnd,
            List<UUID> activeRouteOrderIds) {}

    public record OrderSnapshotDto(
            UUID orderId,
            UUID hubId,
            UUID courierId,
            OrderStatus status,
            BigDecimal weightKg,
            double pickupLat,
            double pickupLon,
            double dropoffLat,
            double dropoffLon,
            Instant windowStart,
            Instant windowEnd,
            int serviceDurationSeconds,
            int version) {}

    public record RouteWaypointDto(
            UUID orderId,
            double lat,
            double lon,
            long arrivalUnix,
            long departureUnix,
            long slackSeconds,
            long accumulatedLoadKg,
            BigDecimal weightKg,
            long windowStartUnix,
            long windowEndUnix) {}

    public record RoutePetalDto(
            UUID courierId,
            UUID hubId,
            String courierName,
            long totalDistanceMeters,
            long totalDurationSeconds,
            double capacityUsedKg,
            double maxCapacityKg,
            String encodedPolyline,
            List<RouteWaypointDto> waypoints,
            List<List<Double>> pathCoords) {}

    public record SolveTelemetryDto(
            String requestId,
            String solverStatus,
            long solveDurationMs,
            long matrixPreprocessMs,
            int activeWorkerThreads,
            double objectiveCost,
            int iterationsCompleted,
            Instant timestamp) {}

    public record SnapshotResponse(
            Instant generatedAt,
            GeoCoordDto regionCenter,
            List<HubSnapshotDto> hubs,
            Map<String, Object> zonesGeoJson,
            List<CourierSnapshotDto> couriers,
            List<OrderSnapshotDto> orders,
            List<RoutePetalDto> routes,
            SolveTelemetryDto latestSolve) {}

    public record ReoptimizeRequest(
            UUID hubId,
            Integer batchSize,
            Double weatherSeverityScore,
            Double speedMultiplier) {}

    public record ReoptimizeResponse(
            DispatchBatchResult batchResult,
            List<RoutePetalDto> beforeRoutes,
            List<RoutePetalDto> afterRoutes,
            long distanceSavedMeters,
            int resolvedViolations,
            List<UUID> reassignedOrderIds,
            SolveTelemetryDto solveTelemetry) {}

    public record OrchestratorMetricsResponse(
            String status,
            boolean virtualThreadsEnabled,
            int activeVirtualThreads,
            int bulkheadMaxPermits,
            int bulkheadAvailablePermits,
            long bulkheadTotalAcquisitions,
            int peakConcurrentBatchHolders,
            int hikariActiveConnections,
            int hikariIdleConnections,
            int hikariMaxConnections,
            double postgisQueryLatencyMs,
            long solverDeadlineMs,
            long lastSolveDurationMs,
            long lastMatrixPreprocessMs,
            double lastObjectiveCost,
            int lastIterationsCompleted,
            int solverWorkers) {}
}
