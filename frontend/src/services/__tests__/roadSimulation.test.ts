import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCATION_BOOKMARKS } from '../../constants/bookmarks.ts';
import {
  computeCompassBearingDeg,
  decodePolyline5,
  encodePolyline5,
  extractSubpath,
  haversineMeters,
  pointToPolylineDistanceMeters,
  precomputePolyline,
  samplePolylineAtDistance,
  sliceRemainingPolyline,
  smoothPathCorners,
} from '../polylineKinematics.ts';
import {
  buildRoadNetworkGraph,
  createFallbackUrbanRoadGraph,
  RoadNetworkGraph,
  type RawRoadSegment,
} from '../roadNetwork.ts';
import {
  solveAlnsCvrptw,
  type AlnsStopInput,
  type AlnsVehicleInput,
} from '../alnsSolver.ts';
import {
  applyOsrmRouteShapeToCourier,
  collectUnhydratedOsrmRouteRequests,
  createSandboxState,
  stepSandboxSimulation,
  triggerSandboxReoptimize,
  upgradeSandboxRoadGraph,
} from '../sandboxSimulator.ts';

test('polylineKinematics: spherical compass bearings at London latitude account for cos(lat)', () => {
  const lat = 51.5074;
  const lon = -0.1278;
  assert.ok(Math.abs(computeCompassBearingDeg(lat, lon, lat + 0.01, lon) - 0) < 0.2);
  assert.ok(Math.abs(computeCompassBearingDeg(lat, lon, lat, lon + 0.01) - 90) < 0.2);
  assert.ok(Math.abs(computeCompassBearingDeg(lat, lon, lat - 0.01, lon) - 180) < 0.2);
  assert.ok(Math.abs(computeCompassBearingDeg(lat, lon, lat, lon - 0.01) - 270) < 0.2);
});

test('polylineKinematics: polyline5 roundtrip & corner-preserving extractSubpath', () => {
  const lShape: [number, number][] = [
    [-0.1278, 51.5074],
    [-0.1278, 51.5084], // ~111m North
    [-0.1262, 51.5084], // ~111m East
  ];
  const encoded = encodePolyline5(lShape);
  const decoded = decodePolyline5(encoded);
  assert.equal(decoded.length, 3);
  assert.ok(haversineMeters(decoded[2][1], decoded[2][0], lShape[2][1], lShape[2][0]) < 2.0);

  const poly = precomputePolyline(lShape);
  const mid = samplePolylineAtDistance(poly, poly.segmentLengthsM[0] * 0.5);
  assert.ok(Math.abs(mid.headingDeg - 0) < 1.0);

  // Extract subpath spanning across the 90-degree corner; must retain corner vertex!
  const cornerSubpath = extractSubpath(
    poly,
    poly.segmentLengthsM[0] - 20,
    poly.segmentLengthsM[0] + 20,
  );
  assert.equal(cornerSubpath.length, 3);
  assert.ok(haversineMeters(cornerSubpath[1][1], cornerSubpath[1][0], 51.5084, -0.1278) < 1.0);

  const remaining = sliceRemainingPolyline(poly, poly.segmentLengthsM[0] * 0.5);
  assert.equal(remaining.length, 3);
});

test('roadNetwork: merges crossing streets, prunes dead-ends via Tarjan SCC, and routes via A*', () => {
  const segs: RawRoadSegment[] = [
    // Square loop with an intermediate bend vertex on the north side + a dead-end one-way stub
    {
      coords: [
        [-0.130, 51.505],
        [-0.130, 51.507],
        [-0.128, 51.5075], // degree-2 curved bend
        [-0.126, 51.507],
      ],
      roadClass: 'primary',
      oneway: false,
    },
    {
      coords: [
        [-0.126, 51.507],
        [-0.126, 51.505],
        [-0.130, 51.505],
      ],
      roadClass: 'secondary',
      oneway: false,
    },
    // Dead-end one-way spur leading nowhere (should be pruned by Tarjan SCC)
    {
      coords: [
        [-0.126, 51.507],
        [-0.122, 51.509],
      ],
      roadClass: 'minor',
      oneway: true,
    },
  ];

  const graph = buildRoadNetworkGraph('london', 'vector-tiles', segs, 10);
  assert.ok(graph.nodes.length >= 2);
  assert.ok(graph.edges.length >= 2);

  // Every pair of nodes in the cleaned graph must be mutually reachable
  for (let u = 0; u < graph.nodes.length; u += 1) {
    for (let v = 0; v < graph.nodes.length; v += 1) {
      const path = graph.findRoadPath(u, v);
      assert.equal(path.reachable, true);
    }
  }
});

test('sandboxSimulator: UUID integrity holds across all 6 bookmark cities on initial boot', () => {
  for (const bm of LOCATION_BOOKMARKS) {
    const state = createSandboxState(bm.id, 60);
    const orderIds = new Set(state.orders.map((o) => o.orderId));

    let totalActiveStops = 0;
    for (const c of state.couriers) {
      for (const oid of c.activeRouteOrderIds) {
        assert.ok(
          orderIds.has(oid),
          `City ${bm.id}: courier ${c.name} references unknown orderId ${oid}`,
        );
        totalActiveStops += 1;
      }
    }
    assert.ok(totalActiveStops > 0, `City ${bm.id}: expected active assigned stops`);
    assert.ok(state.routes.length > 0, `City ${bm.id}: expected initial road-routed petals`);
    for (const route of state.routes) {
      assert.ok(route.waypoints.length > 0, `City ${bm.id}: route has empty waypoints`);
      assert.ok(route.pathCoords.length >= 2, `City ${bm.id}: route has insufficient pathCoords`);
    }
  }
});

test('sandboxSimulator: zero teleportation, strict road-adherence, and full delivery lifecycle over 120 ticks', () => {
  let state = createSandboxState('london', 50);
  const initialDelivered = state.orders.filter((o) => o.status === 'DELIVERED').length;
  let movedChecks = 0;

  for (let tick = 0; tick < 120; tick += 1) {
    const prevById = new Map(state.couriers.map((c) => [c.courierId, c]));
    const { nextState, subpathsByCourierId } = stepSandboxSimulation(state, 1.0);

    for (const c of nextState.couriers) {
      const prev = prevById.get(c.courierId);
      if (!prev) continue;
      const stepDist = haversineMeters(prev.lat, prev.lon, c.lat, c.lon);
      // No courier may ever teleport (max physical step at 26 m/s * 1s + rounding tolerance)
      assert.ok(
        stepDist <= 32,
        `Courier ${c.name} jumped ${stepDist.toFixed(1)}m in 1s at tick ${tick}`,
      );

      // Every courier with an active road leg must remain strictly on its leg polyline
      const kin = nextState.kinematicsByCourierId[c.courierId];
      if (kin && kin.legPoly.coords.length >= 2 && kin.targetType !== 'IDLE') {
        const offRoadM = pointToPolylineDistanceMeters(c.lat, c.lon, kin.legPoly.coords);
        assert.ok(
          offRoadM <= 2.5,
          `Courier ${c.name} drifted ${offRoadM.toFixed(2)}m off its road polyline`,
        );
        if (stepDist > 1) {
          movedChecks += 1;
          assert.ok(
            (subpathsByCourierId[c.courierId]?.length ?? 0) >= 2,
            `Moving courier ${c.name} missing corner-following subpath`,
          );
        }
      }
    }

    state = nextState;
  }

  assert.ok(movedChecks > 500, 'Expected substantial active road movement across ticks');
  const finalDelivered = state.orders.filter((o) => o.status === 'DELIVERED').length;
  assert.ok(
    state.completedDeliveriesCount > 0 && finalDelivered > initialDelivered,
    `Expected deliveries to progress (completed=${state.completedDeliveriesCount}, initial=${initialDelivered}, final=${finalDelivered})`,
  );

  // Test road-aware re-optimization and road-graph hot-swap
  const reopt = triggerSandboxReoptimize(state, { batchSize: 20, weatherSeverityScore: 0.6 });
  assert.ok(reopt.response.afterRoutes.length > 0);

  const freshGraph = createFallbackUrbanRoadGraph('london');
  const upgraded = upgradeSandboxRoadGraph(reopt.nextState, freshGraph);
  assert.equal(upgraded.couriers.length, reopt.nextState.couriers.length);
  assert.ok(upgraded.routes.length > 0);
});

test('road adherence: smoothPathCorners preserves exact OSM road vertices without Bezier distortion', () => {
  const sharpTurn: [number, number][] = [
    [-0.1278, 51.5074],
    [-0.1278, 51.5084], // ~111m North
    [-0.1262, 51.5084], // ~111m East
  ];
  const cleaned = smoothPathCorners(sharpTurn, 14, 4);
  assert.equal(cleaned.length, 3, 'Expected exact 3 OSM road vertices with zero Bezier fillets');
  assert.deepEqual(cleaned, sharpTurn);
});

test('vector-tile 2D crossing noding connects streets without shared vertices', () => {
  // Two closed loops that cross in an X without sharing a single explicit vertex!
  const segs: RawRoadSegment[] = [
    {
      coords: [
        [-0.132, 51.506],
        [-0.124, 51.510], // SW -> NE diagonal
      ],
      roadClass: 'primary',
      oneway: false,
    },
    {
      coords: [
        [-0.132, 51.510],
        [-0.124, 51.506], // NW -> SE diagonal (crosses at -0.128, 51.508)
      ],
      roadClass: 'primary',
      oneway: false,
    },
    // Close perimeter so all 4 outer endpoints + crossing node belong to 1 strongly connected graph
    {
      coords: [
        [-0.132, 51.506],
        [-0.132, 51.510],
        [-0.124, 51.510],
        [-0.124, 51.506],
        [-0.132, 51.506],
      ],
      roadClass: 'secondary',
      oneway: false,
    },
  ];

  const graph = buildRoadNetworkGraph('london', 'vector-tiles', segs, 12);
  // Crossing noding must create the central intersection node near (-0.128, 51.508)
  const centerNode = graph.findNearestNode(51.508, -0.128);
  const centerPt = graph.nodes[centerNode];
  assert.ok(
    haversineMeters(centerPt.lat, centerPt.lon, 51.508, -0.128) < 25,
    'Expected 2D crossing noding to insert intersection node at street crossing',
  );
  assert.ok(graph.outgoing[centerNode].length >= 4, 'Crossing node should have 4 outgoing roads');
});

test('OSRM speed calibration, matrix precomputation, serialization & local ALNS CVRPTW solver', () => {
  const graph = createFallbackUrbanRoadGraph('london');
  assert.ok(graph.nodes.length >= 40);

  // 1. Test OSRM Table speed calibration scaling and serialization roundtrip
  const origDur = graph.findRoadPath(0, 10).totalDurationSec;
  graph.applyOsrmSpeedCalibration(0.8, true);
  const calibratedDur = graph.findRoadPath(0, 10).totalDurationSec;
  assert.ok(calibratedDur > origDur, 'Lower OSRM speed scale (<1.0) must increase road travel duration');

  const serialized = graph.toSerialized();
  const restored = RoadNetworkGraph.fromSerialized(serialized);
  assert.ok(restored !== null);
  assert.equal(restored!.nodes.length, graph.nodes.length);
  assert.equal(restored!.edges.length, graph.edges.length);
  assert.equal(restored!.osrmSpeedScale, 0.8);

  // 2. Test road-network distance/duration matrix & local ALNS CVRPTW solver
  const sampleNodes = [0, 5, 12, 18, 25, 32, 40];
  const mat = restored!.computeDistanceDurationMatrix(sampleNodes);
  assert.equal(mat.dim, sampleNodes.length);
  for (let i = 0; i < sampleNodes.length; i += 1) {
    assert.equal(mat.durationsSec[i * mat.dim + i], 0);
    for (let j = 0; j < sampleNodes.length; j += 1) {
      if (i !== j) {
        assert.ok(mat.distancesM[i * mat.dim + j] > 0);
        assert.ok(mat.durationsSec[i * mat.dim + j] > 0);
      }
    }
  }

  const nowUnix = 1_700_000_000;
  const vehicles: AlnsVehicleInput[] = [
    {
      courierId: 'veh-1',
      startNodeId: 0,
      endNodeId: 0,
      maxCapacityKg: 30,
      maxStops: 4,
      paceFactor: 1.0,
    },
    {
      courierId: 'veh-2',
      startNodeId: 10,
      endNodeId: 10,
      maxCapacityKg: 30,
      maxStops: 4,
      paceFactor: 1.0,
    },
  ];
  const stops: AlnsStopInput[] = [5, 12, 18, 25, 32, 40].map((nid, idx) => ({
    orderId: `ord-${idx + 1}`,
    nodeId: nid,
    weightKg: 8,
    windowStartUnix: nowUnix - 300,
    windowEndUnix: nowUnix + 1800 + idx * 120,
    serviceDurationSec: 90,
  }));

  const sol = solveAlnsCvrptw(vehicles, stops, restored!, {
    nowUnix,
    iterations: 64,
    seed: 42,
  });

  assert.equal(sol.unassignedOrderIds.length, 0, 'All 6 stops should be feasibly assigned across 2 vehicles');
  const totalAssigned = sol.routes.reduce((acc, r) => acc + r.schedule.length, 0);
  assert.equal(totalAssigned, 6);
  assert.ok(sol.objectiveCost <= sol.initialObjectiveCost);
  assert.ok(sol.convergenceHistory.length >= 2);
});

test('OSRM multi-stop street geometry hydration preserves exact curved OSRM legs across stop transitions', () => {
  let state = createSandboxState('london', 24);
  const specs = collectUnhydratedOsrmRouteRequests(state);
  assert.ok(specs.length > 0, 'Expected active couriers awaiting OSRM route geometry hydration');

  const spec = specs[0];
  // Construct a synthetic multi-vertex curved OSRM /route/v1/driving/ response matching spec.legTargets
  const fakeOsrmLegs = spec.legTargets.map((_, legIdx) => {
    const startPt = spec.waypointsLonLat[legIdx];
    const endPt = spec.waypointsLonLat[legIdx + 1];
    const mid1: [number, number] = [
      Number((startPt[0] + (endPt[0] - startPt[0]) * 0.33 + 0.0012).toFixed(6)),
      Number((startPt[1] + (endPt[1] - startPt[1]) * 0.33 - 0.0008).toFixed(6)),
    ];
    const mid2: [number, number] = [
      Number((startPt[0] + (endPt[0] - startPt[0]) * 0.66 - 0.0009).toFixed(6)),
      Number((startPt[1] + (endPt[1] - startPt[1]) * 0.66 + 0.0011).toFixed(6)),
    ];
    return {
      coords: [startPt, mid1, mid2, endPt] as [number, number][],
      distanceM: 650,
      durationSec: 55,
      avgSpeedMps: 11.8,
    };
  });

  const fullCoords = fakeOsrmLegs.flatMap((l, idx) => (idx === 0 ? l.coords : l.coords.slice(1)));
  state = applyOsrmRouteShapeToCourier(state, spec, {
    cacheKey: 'test-osrm-key',
    fullCoords,
    legs: fakeOsrmLegs,
    snappedWaypoints: spec.waypointsLonLat,
    totalDistanceM: fakeOsrmLegs.length * 650,
    totalDurationSec: fakeOsrmLegs.length * 55,
  });

  const kinAfterHydrate = state.kinematicsByCourierId[spec.courierId];
  assert.equal(kinAfterHydrate.isOsrmHydrated, true);
  assert.deepEqual(kinAfterHydrate.legPoly.coords, fakeOsrmLegs[0].coords);
  assert.equal(kinAfterHydrate.upcomingLegs?.length, fakeOsrmLegs.length - 1);

  // Verify upgradeSandboxRoadGraph does NOT overwrite an OSRM-hydrated courier's route
  const upgradedState = upgradeSandboxRoadGraph(state, createFallbackUrbanRoadGraph('london'));
  assert.equal(upgradedState.kinematicsByCourierId[spec.courierId].isOsrmHydrated, true);
  assert.deepEqual(
    upgradedState.kinematicsByCourierId[spec.courierId].legPoly.coords,
    fakeOsrmLegs[0].coords,
  );
});
