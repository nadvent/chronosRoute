package com.chronosroute.orchestrator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.chronosroute.orchestrator.domain.Courier;
import com.chronosroute.orchestrator.domain.CourierStatus;
import com.chronosroute.orchestrator.domain.GeoPoint;
import com.chronosroute.orchestrator.domain.Order;
import com.chronosroute.orchestrator.dto.OrderDtos.DispatchTriggerRequest;
import com.chronosroute.orchestrator.dto.OrderDtos.RoutePetalDto;
import com.chronosroute.orchestrator.dto.OrderDtos.SnapshotResponse;
import com.chronosroute.orchestrator.grpc.SolverGrpcClient;
import com.chronosroute.orchestrator.repository.DispatchRepository;
import com.chronosroute.orchestrator.service.OrderDispatchService;
import com.chronosroute.orchestrator.service.VirtualThreadBulkhead;
import com.chronosroute.proto.v1.CVRPTWResponse;
import com.chronosroute.proto.v1.ScheduledStop;
import com.chronosroute.proto.v1.SolverStatus;
import com.chronosroute.proto.v1.VehicleRoute;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

@Tag("unit")
class RoutePolylineDecodingTest {

    private static String encodeCoords(List<List<Double>> lonLatCoords) {
        StringBuilder sb = new StringBuilder();
        long prevLat = 0;
        long prevLon = 0;
        for (List<Double> pt : lonLatCoords) {
            long lonE5 = Math.round(pt.get(0) * 1e5);
            long latE5 = Math.round(pt.get(1) * 1e5);
            encodeSigned(latE5 - prevLat, sb);
            encodeSigned(lonE5 - prevLon, sb);
            prevLat = latE5;
            prevLon = lonE5;
        }
        return sb.toString();
    }

    private static void encodeSigned(long v, StringBuilder out) {
        long sgn = v < 0 ? ~(v << 1) : (v << 1);
        while (sgn >= 0x20) {
            out.append((char) ((0x20 | (sgn & 0x1f)) + 63));
            sgn >>= 5;
        }
        out.append((char) (sgn + 63));
    }

    @Test
    void testDecodePolylinePreservesMultiVertexRoadGeometry() {
        List<List<Double>> roadPath = List.of(
                List.of(-0.1278, 51.5074),
                List.of(-0.1240, 51.5074),
                List.of(-0.1240, 51.5110),
                List.of(-0.1195, 51.5110));
        String encoded = encodeCoords(roadPath);

        List<List<Double>> decoded = OrderDispatchService.decodePolyline(encoded);
        assertEquals(roadPath.size(), decoded.size());
        for (int i = 0; i < roadPath.size(); i++) {
            assertEquals(roadPath.get(i).get(0), decoded.get(i).get(0), 1e-4);
            assertEquals(roadPath.get(i).get(1), decoded.get(i).get(1), 1e-4);
        }
    }

    @Test
    void testDispatchStoresDecodedSolverRoadPolylineInRoutePetal() {
        DispatchRepository repository = new DispatchRepository();
        VirtualThreadBulkhead bulkhead = new VirtualThreadBulkhead(16);

        UUID hubId = UUID.randomUUID();
        UUID courierId = UUID.randomUUID();
        Instant now = Instant.now();

        Courier courier = new Courier(
                courierId,
                "UK-RoadTest-01",
                CourierStatus.IDLE,
                BigDecimal.valueOf(80),
                BigDecimal.valueOf(80),
                new GeoPoint(51.5074, -0.1278),
                now,
                now.minusSeconds(3600),
                now.plusSeconds(7200),
                now,
                0,
                List.of(),
                "");
        repository.saveCourier(courier);

        Order order = Order.createNew(
                hubId,
                BigDecimal.valueOf(5.0),
                new GeoPoint(51.5074, -0.1278),
                new GeoPoint(51.5135, -0.1140),
                1L,
                now,
                now.plusSeconds(1800),
                120);
        repository.saveNewOrder(order);

        List<List<Double>> multiTurnRoad = List.of(
                List.of(-0.1278, 51.5074),
                List.of(-0.1230, 51.5074),
                List.of(-0.1230, 51.5110),
                List.of(-0.1180, 51.5110),
                List.of(-0.1140, 51.5135));
        String solverPolyline = encodeCoords(multiTurnRoad);

        SolverGrpcClient mockSolver = new SolverGrpcClient(
                "localhost",
                50051,
                req -> CVRPTWResponse.newBuilder()
                        .setRequestId(req.getRequestId())
                        .setStatus(SolverStatus.SOLVER_STATUS_OPTIMAL)
                        .setSolverDurationMs(42)
                        .setIterationsCompleted(500)
                        .setObjectiveCost(1234.5)
                        .addRoutes(VehicleRoute.newBuilder()
                                .setVehicleId(courierId.toString())
                                .setTotalDistanceMeters(1850)
                                .setTotalDurationSeconds(185)
                                .setEncodedPolyline(solverPolyline)
                                .addScheduledStops(ScheduledStop.newBuilder()
                                        .setStopId(order.getOrderId().toString())
                                        .setEstimatedArrivalUnix(now.getEpochSecond() + 185)
                                        .setEstimatedDepartureUnix(now.getEpochSecond() + 305)
                                        .setSlackSeconds(1615)
                                        .setAccumulatedLoadKg(5)
                                        .build())
                                .build())
                        .build());

        try {
            OrderDispatchService service = new OrderDispatchService(repository, bulkhead, mockSolver);
            service.dispatchBatch(
                    new DispatchTriggerRequest(hubId, 10, 0.0),
                    "poly-test-" + UUID.randomUUID(),
                    "trace-poly");

            SnapshotResponse snapshot = service.getSnapshot(50);
            assertEquals(1, snapshot.routes().size());
            RoutePetalDto petal = snapshot.routes().get(0);
            assertEquals(solverPolyline, petal.encodedPolyline());
            // Must preserve all 5 road-following vertices instead of collapsing to a 2-point chord
            assertEquals(multiTurnRoad.size(), petal.pathCoords().size());
            assertTrue(Math.abs(petal.pathCoords().get(2).get(1) - 51.5110) < 1e-4);
        } finally {
            mockSolver.shutdown();
        }
    }
}
