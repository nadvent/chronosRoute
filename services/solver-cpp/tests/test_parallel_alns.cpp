#include "chronos/alns_solver.hpp"
#include "chronos/grpc_server.hpp"
#include "chronos/onnx_scorer.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <stop_token>
#include <string>
#include <unordered_map>
#include <vector>

namespace chronos {
namespace {

TEST(ParallelALNSTest, CapacityTimeWindowsAndForwardSlackO1) {
    auto graph = CsrGraph::create_synthetic_grid(10, 10);
    auto sp_engine = std::make_shared<ShortestPathEngine>(graph, 6);
    ThreadPool pool(4, 128);

    std::vector<AlnsVehicle> vehicles = {
        AlnsVehicle{"veh-1", 100, 1000, 20000,
                    graph->node_coords()[0], graph->node_coords()[0], 10},
        AlnsVehicle{"veh-2", 100, 1000, 20000,
                    graph->node_coords()[0], graph->node_coords()[0], 10},
    };

    std::vector<AlnsStop> stops = {
        AlnsStop{"stop-1", graph->node_coords()[12], 40, 1100, 5000, 60, StopKind::Dropoff, "", 1},
        AlnsStop{"stop-2", graph->node_coords()[25], 45, 1200, 6000, 60, StopKind::Dropoff, "", 1},
        AlnsStop{"stop-3", graph->node_coords()[48], 50, 1500, 7000, 60, StopKind::Dropoff, "", 1},
        AlnsStop{"stop-4", graph->node_coords()[63], 35, 1800, 8000, 60, StopKind::Dropoff, "", 1},
    };

    AlnsConfig config;
    config.deadline_ms = 400;
    config.num_search_trajectories = 4;
    config.max_iterations_per_trajectory = 60;
    config.hard_time_windows = true;
    config.allow_unassigned_stops = false;

    ParallelAlnsSolver solver(graph, sp_engine, &pool);
    const AlnsSolution sol = solver.solve(vehicles, stops, config);

    EXPECT_EQ(sol.status, AlnsStatus::Feasible);
    EXPECT_TRUE(sol.unassigned_stop_ids.empty());
    EXPECT_GT(sol.iterations_completed, 0);

    size_t assigned_count = 0;
    for (const auto& route : sol.routes) {
        EXPECT_TRUE(route.feasible);
        assigned_count += route.schedule.size();
        for (size_t pos = 0; pos < route.schedule.size(); ++pos) {
            const auto& sched = route.schedule[pos];
            EXPECT_LE(sched.accumulated_load_kg, 100);
            EXPECT_GE(sched.forward_tw_slack_seconds, 0);
            EXPECT_TRUE(ParallelAlnsSolver::check_forward_slack_o1(
                route, pos, sched.forward_tw_slack_seconds));
            EXPECT_FALSE(ParallelAlnsSolver::check_forward_slack_o1(
                route, pos, sched.forward_tw_slack_seconds + 1));
        }
    }
    EXPECT_EQ(assigned_count, stops.size());
}

TEST(ParallelALNSTest, PickupBeforeDropoffPrecedenceConstraint) {
    auto graph = CsrGraph::create_synthetic_grid(8, 8);
    auto sp_engine = std::make_shared<ShortestPathEngine>(graph, 6);
    ThreadPool pool(4, 128);

    std::vector<AlnsVehicle> vehicles = {
        AlnsVehicle{"veh-alpha", 200, 0, 30000,
                    graph->node_coords()[0], graph->node_coords()[0], 10},
        AlnsVehicle{"veh-beta", 200, 0, 30000,
                    graph->node_coords()[63], graph->node_coords()[63], 10},
    };

    std::vector<AlnsStop> stops = {
        AlnsStop{"pickup-A", graph->node_coords()[10], 30, 100, 10000, 30,
                 StopKind::Pickup, "dropoff-A", 1},
        AlnsStop{"dropoff-A", graph->node_coords()[45], 30, 500, 15000, 30,
                 StopKind::Dropoff, "pickup-A", 1},
        AlnsStop{"pickup-B", graph->node_coords()[20], 40, 200, 12000, 30,
                 StopKind::Pickup, "dropoff-B", 1},
        AlnsStop{"dropoff-B", graph->node_coords()[55], 40, 600, 18000, 30,
                 StopKind::Dropoff, "pickup-B", 1},
    };

    AlnsConfig config;
    config.deadline_ms = 400;
    config.num_search_trajectories = 4;
    config.max_iterations_per_trajectory = 80;
    config.allow_unassigned_stops = false;

    ParallelAlnsSolver solver(graph, sp_engine, &pool);
    const AlnsSolution sol = solver.solve(vehicles, stops, config);

    EXPECT_EQ(sol.status, AlnsStatus::Feasible);
    EXPECT_TRUE(sol.unassigned_stop_ids.empty());

    std::unordered_map<std::string, std::pair<std::string, size_t>> stop_placement;
    for (const auto& route : sol.routes) {
        for (size_t idx = 0; idx < route.schedule.size(); ++idx) {
            stop_placement[route.schedule[idx].stop_id] = {route.vehicle_id, idx};
        }
    }

    ASSERT_EQ(stop_placement.size(), 4U);
    // Pickup and dropoff must be on the exact same vehicle, with pickup index < dropoff index
    EXPECT_EQ(stop_placement["pickup-A"].first, stop_placement["dropoff-A"].first);
    EXPECT_LT(stop_placement["pickup-A"].second, stop_placement["dropoff-A"].second);

    EXPECT_EQ(stop_placement["pickup-B"].first, stop_placement["dropoff-B"].first);
    EXPECT_LT(stop_placement["pickup-B"].second, stop_placement["dropoff-B"].second);
}

TEST(ParallelALNSTest, DeadlineExpirationReturnsTimeoutBestEffort) {
    auto graph = CsrGraph::create_synthetic_grid(8, 8);
    auto sp_engine = std::make_shared<ShortestPathEngine>(graph, 4);
    ThreadPool pool(2, 64);

    std::vector<AlnsVehicle> vehicles = {
        AlnsVehicle{"veh-1", 500, 0, 50000,
                    graph->node_coords()[0], graph->node_coords()[0], 20},
    };
    std::vector<AlnsStop> stops = {
        AlnsStop{"s1", graph->node_coords()[15], 20, 0, 10000, 30, StopKind::Dropoff, "", 1},
        AlnsStop{"s2", graph->node_coords()[35], 20, 0, 10000, 30, StopKind::Dropoff, "", 1},
    };

    AlnsConfig config;
    config.deadline_ms = 500;
    config.num_search_trajectories = 2;
    config.max_iterations_per_trajectory = 500;

    ParallelAlnsSolver solver(graph, sp_engine, &pool);
    // Trigger immediate cancellation via callback (simulating gRPC ServerContext::IsCancelled)
    const AlnsSolution sol = solver.solve(
        vehicles, stops, config, {}, 0, {}, []() { return true; });

    EXPECT_EQ(sol.status, AlnsStatus::TimeoutBestEffort);
    EXPECT_TRUE(sol.deadline_exceeded);
    EXPECT_TRUE(sol.unassigned_stop_ids.empty());
}

TEST(ParallelALNSTest, OnnxEdgeScorerBatchInferenceAndFallback) {
    // 1. Test graceful fallback when model path does not exist
    OnnxEdgeScorer fallback_scorer("nonexistent_model_file.onnx");
    EXPECT_FALSE(fallback_scorer.has_active_session());

    std::vector<EdgeFeatureVector> batch = {
        EdgeFeatureVector{0.0f, 1.0f, 0.5f, 0.86f, 2.0f, 0.0f, 5.0f, 0.0f},   // Clear night
        EdgeFeatureVector{0.8f, -0.6f, 0.5f, 0.86f, 2.0f, 25.0f, 40.0f, 0.8f}, // Storm + traffic
    };

    const std::vector<float> scores = fallback_scorer.score_batch(batch);
    ASSERT_EQ(scores.size(), 2U);
    EXPECT_GT(scores[0], scores[1]); // Clear night has higher speed multiplier than storm+traffic
    EXPECT_GE(scores[1], 0.15f);
    EXPECT_LE(scores[0], 1.25f);

    // 2. Test real Ort::Session inference on models/eta_residual_v1.onnx
    OnnxEdgeScorer real_scorer("");
    if (real_scorer.has_active_session()) {
        const std::vector<float> onnx_scores = real_scorer.score_batch(batch);
        ASSERT_EQ(onnx_scores.size(), 2U);
        EXPECT_GE(onnx_scores[0], 0.05f);
        EXPECT_LE(onnx_scores[0], 2.0f);
        EXPECT_GE(onnx_scores[1], 0.05f);
        EXPECT_LE(onnx_scores[1], 2.0f);
    }
}

TEST(ParallelALNSTest, EndToEndGrpcServiceAndTracePropagation) {
    RoutingServiceImpl service(CsrGraph::create_synthetic_grid(6, 6), 4);

    // 1. CheckHealth RPC
    {
        grpc::ServerContext ctx;
        chronos::routing::v1::HealthRequest req;
        req.set_client_id("test-suite");
        chronos::routing::v1::HealthResponse resp;
        const grpc::Status st = service.CheckHealth(&ctx, &req, &resp);
        EXPECT_TRUE(st.ok());
        EXPECT_TRUE(resp.healthy());
        EXPECT_EQ(resp.active_workers(), 4);
        EXPECT_EQ(resp.graph_nodes_count(), 36);
    }

    // 2. UpdateTrafficMultipliers RPC
    {
        grpc::ServerContext ctx;
        chronos::routing::v1::TrafficUpdateRequest req;
        req.set_batch_id("batch-42");
        req.set_timestamp_unix(1700005000);
        auto* m = req.add_edge_multipliers();
        m->set_edge_id(1000);
        m->set_speed_multiplier(0.60f);

        chronos::routing::v1::TrafficUpdateResponse resp;
        const grpc::Status st = service.UpdateTrafficMultipliers(&ctx, &req, &resp);
        EXPECT_TRUE(st.ok());
        EXPECT_TRUE(resp.success());
        EXPECT_EQ(resp.batch_id(), "batch-42");
        EXPECT_EQ(resp.edges_updated(), 1);
        EXPECT_GT(resp.update_latency_micros(), 0);
    }

    // 3. ComputeDistanceMatrix RPC
    {
        grpc::ServerContext ctx;
        chronos::routing::v1::MatrixRequest req;
        req.set_matrix_id("mat-1");
        for (uint32_t idx : {0U, 15U, 35U}) {
            const auto coord = service.graph()->node_coords()[idx];
            auto* o = req.add_origins();
            o->set_latitude(coord.latitude);
            o->set_longitude(coord.longitude);
            auto* d = req.add_destinations();
            d->set_latitude(coord.latitude);
            d->set_longitude(coord.longitude);
        }

        chronos::routing::v1::MatrixResponse resp;
        const grpc::Status st = service.ComputeDistanceMatrix(&ctx, &req, &resp);
        EXPECT_TRUE(st.ok());
        EXPECT_EQ(resp.rows(), 3);
        EXPECT_EQ(resp.cols(), 3);
        ASSERT_EQ(resp.durations_ms_size(), 9);
        EXPECT_EQ(resp.durations_ms(0), 0);
        EXPECT_GT(resp.durations_ms(2), 0);
    }

    // 4. SolveCVRPTW RPC
    chronos::routing::v1::CVRPTWRequest solve_req;
    solve_req.set_request_id("req-999");
    auto* veh = solve_req.add_vehicles();
    veh->set_vehicle_id("courier-1");
    veh->set_max_weight_kg(250);
    veh->set_shift_start_unix(0);
    veh->set_shift_end_unix(36000);
    veh->mutable_start_location()->set_latitude(37.7749);
    veh->mutable_start_location()->set_longitude(-122.4194);
    veh->set_max_stops(10);

    auto* s1 = solve_req.add_stops();
    s1->set_stop_id("order-1");
    s1->mutable_coordinate()->set_latitude(37.7800);
    s1->mutable_coordinate()->set_longitude(-122.4100);
    s1->set_demand_kg(25);
    s1->set_window_start_unix(100);
    s1->set_window_end_unix(7200);
    s1->set_service_duration_seconds(60);
    s1->set_stop_type(chronos::routing::v1::STOP_TYPE_DROPOFF);

    auto* s2 = solve_req.add_stops();
    s2->set_stop_id("order-2");
    s2->mutable_coordinate()->set_latitude(37.7850);
    s2->mutable_coordinate()->set_longitude(-122.4050);
    s2->set_demand_kg(30);
    s2->set_window_start_unix(200);
    s2->set_window_end_unix(7200);
    s2->set_service_duration_seconds(60);
    s2->set_stop_type(chronos::routing::v1::STOP_TYPE_DROPOFF);

    solve_req.mutable_constraints()->set_deadline_ms(300);
    solve_req.mutable_constraints()->set_num_search_trajectories(4);

#if defined(__SANITIZE_THREAD__)
    // Under TSan, invoke SolveCVRPTW directly on the service so our 4 C++20 jthread
    // ALNS trajectories are race-checked without spawning uninstrumented /usr/lib/libgrpc.so
    // internal event_engine threads.
    grpc::ServerContext srv_ctx;
    chronos::routing::v1::CVRPTWResponse solve_resp;
    const grpc::Status solve_st = service.SolveCVRPTW(&srv_ctx, &solve_req, &solve_resp);
    EXPECT_TRUE(solve_st.ok());
    EXPECT_EQ(solve_resp.request_id(), "req-999");
    EXPECT_EQ(solve_resp.status(), chronos::routing::v1::SOLVER_STATUS_FEASIBLE);
    ASSERT_EQ(solve_resp.routes_size(), 1);
    EXPECT_EQ(solve_resp.routes(0).scheduled_stops_size(), 2);
    EXPECT_EQ(service.total_solved_requests(), 1);
#else
    grpc::ServerBuilder builder;
    builder.RegisterService(&service);
    std::unique_ptr<grpc::Server> server(builder.BuildAndStart());
    ASSERT_NE(server, nullptr);

    auto channel = server->InProcessChannel(grpc::ChannelArguments());
    auto stub = chronos::routing::v1::RoutingService::NewStub(channel);

    grpc::ClientContext client_ctx;
    client_ctx.AddMetadata("x-trace-id", "trace-cvrptw-999");
    client_ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(450));

    chronos::routing::v1::CVRPTWResponse solve_resp;
    const grpc::Status solve_st = stub->SolveCVRPTW(&client_ctx, solve_req, &solve_resp);
    EXPECT_TRUE(solve_st.ok());
    EXPECT_EQ(solve_resp.request_id(), "req-999");
    EXPECT_EQ(solve_resp.status(), chronos::routing::v1::SOLVER_STATUS_FEASIBLE);
    ASSERT_EQ(solve_resp.routes_size(), 1);
    EXPECT_EQ(solve_resp.routes(0).scheduled_stops_size(), 2);
    EXPECT_EQ(service.last_trace_id(), "trace-cvrptw-999");

    server->Shutdown();
#endif
}

} // namespace
} // namespace chronos
