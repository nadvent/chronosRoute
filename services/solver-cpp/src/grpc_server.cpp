#include "chronos/grpc_server.hpp"

#include <algorithm>
#include <chrono>
#include <string_view>
#include <vector>

namespace chronos {

RoutingServiceImpl::RoutingServiceImpl(
    std::shared_ptr<CsrGraph> graph,
    uint32_t num_workers,
    const std::string& onnx_model_path)
    : graph_(graph ? std::move(graph) : CsrGraph::create_synthetic_grid()),
      sp_engine_(std::make_shared<ShortestPathEngine>(graph_)),
      pool_(std::make_unique<ThreadPool>(num_workers, kDefaultMaxQueueCapacityPerWorker)),
      scorer_(std::make_unique<OnnxEdgeScorer>(onnx_model_path)) {}

std::string RoutingServiceImpl::extract_and_propagate_trace_id(grpc::ServerContext* context) {
    std::string trace_id = "trace-unspecified";
    if (context != nullptr) {
        const auto& client_meta = context->client_metadata();
        auto it = client_meta.find(std::string(kTraceIdHeader));
        if (it != client_meta.end()) {
            trace_id.assign(it->second.data(), it->second.length());
        }
        context->AddInitialMetadata(std::string(kTraceIdHeader), trace_id);
    }
    {
        std::lock_guard<std::mutex> lock(trace_mutex_);
        last_trace_id_ = trace_id;
    }
    return trace_id;
}

std::string RoutingServiceImpl::last_trace_id() const {
    std::lock_guard<std::mutex> lock(trace_mutex_);
    return last_trace_id_;
}

grpc::Status RoutingServiceImpl::SolveCVRPTW(
    grpc::ServerContext* context,
    const chronos::routing::v1::CVRPTWRequest* request,
    chronos::routing::v1::CVRPTWResponse* response) {
    if (request == nullptr || response == nullptr) {
        return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "Null request or response");
    }

    (void)extract_and_propagate_trace_id(context);
    response->set_request_id(request->request_id());

    std::vector<AlnsVehicle> vehicles;
    vehicles.reserve(static_cast<size_t>(request->vehicles_size()));
    for (const auto& pv : request->vehicles()) {
        vehicles.push_back(AlnsVehicle{
            pv.vehicle_id(),
            pv.max_weight_kg() > 0 ? pv.max_weight_kg() : 1000,
            pv.shift_start_unix(),
            pv.shift_end_unix() > 0 ? pv.shift_end_unix() : 86400,
            NodeCoord{pv.start_location().latitude(), pv.start_location().longitude()},
            NodeCoord{pv.end_location().latitude(), pv.end_location().longitude()},
            pv.max_stops() > 0 ? pv.max_stops() : 100,
            0U,
            0U,
        });
    }

    std::vector<AlnsStop> stops;
    stops.reserve(static_cast<size_t>(request->stops_size()));
    for (const auto& ps : request->stops()) {
        StopKind kind = StopKind::Dropoff;
        switch (ps.stop_type()) {
            case chronos::routing::v1::STOP_TYPE_PICKUP:
                kind = StopKind::Pickup;
                break;
            case chronos::routing::v1::STOP_TYPE_DROPOFF:
                kind = StopKind::Dropoff;
                break;
            case chronos::routing::v1::STOP_TYPE_DEPOT:
                kind = StopKind::Depot;
                break;
            default:
                kind = StopKind::Dropoff;
                break;
        }
        stops.push_back(AlnsStop{
            ps.stop_id(),
            NodeCoord{ps.coordinate().latitude(), ps.coordinate().longitude()},
            ps.demand_kg(),
            ps.window_start_unix(),
            ps.window_end_unix(),
            ps.service_duration_seconds(),
            kind,
            ps.paired_stop_id(),
            ps.priority(),
            -1,
            0U,
        });
    }

    AlnsConfig config;
    if (request->has_constraints()) {
        const auto& c = request->constraints();
        config.deadline_ms =
            (c.deadline_ms() > 0) ? c.deadline_ms() : kDefaultSolverDeadlineMs;
        config.num_search_trajectories =
            static_cast<uint32_t>(std::max<int32_t>(1, c.num_search_trajectories()));
        if (c.late_penalty_per_second() > 0.0) {
            config.late_penalty_per_second = c.late_penalty_per_second();
        }
        config.allow_unassigned_stops = c.allow_unassigned_stops();
    }

    // Respect gRPC client context deadline if tighter than request constraint
    if (context != nullptr) {
        const auto grpc_deadline = context->deadline();
        const auto now_sys = std::chrono::system_clock::now();
        if (grpc_deadline < std::chrono::system_clock::time_point::max() - std::chrono::hours(24)) {
            const auto rem_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    grpc_deadline - now_sys)
                                    .count();
            // Reserve a small buffer to serialize response before client deadline expires
            const int64_t safe_budget = std::max<int64_t>(0, rem_ms - 10);
            if (!request->has_constraints() || request->constraints().deadline_ms() <= 0 ||
                safe_budget < config.deadline_ms) {
                config.deadline_ms = safe_budget;
            }
        }
    }

    std::vector<int64_t> precomputed_matrix(
        request->precomputed_duration_matrix_ms().begin(),
        request->precomputed_duration_matrix_ms().end());

    // Capture start/stop coordinates before moving vectors into solver for road polyline encoding
    std::vector<NodeCoord> vehicle_start_coords;
    vehicle_start_coords.reserve(vehicles.size());
    for (const auto& v : vehicles) {
        vehicle_start_coords.push_back(v.start_coord);
    }
    std::vector<NodeCoord> stop_coords;
    stop_coords.reserve(stops.size());
    for (const auto& s : stops) {
        stop_coords.push_back(s.coord);
    }

    ParallelAlnsSolver solver(graph_, sp_engine_, pool_.get());
    AlnsSolution sol = solver.solve(
        std::move(vehicles),
        std::move(stops),
        config,
        precomputed_matrix,
        request->matrix_dimension(),
        {},
        [context]() { return context != nullptr && context->IsCancelled(); });

    switch (sol.status) {
        case AlnsStatus::Optimal:
            response->set_status(chronos::routing::v1::SOLVER_STATUS_OPTIMAL);
            break;
        case AlnsStatus::Feasible:
            response->set_status(chronos::routing::v1::SOLVER_STATUS_FEASIBLE);
            break;
        case AlnsStatus::TimeoutBestEffort:
            response->set_status(chronos::routing::v1::SOLVER_STATUS_TIMEOUT_BEST_EFFORT);
            break;
        case AlnsStatus::Infeasible:
            response->set_status(chronos::routing::v1::SOLVER_STATUS_INFEASIBLE);
            break;
        default:
            response->set_status(chronos::routing::v1::SOLVER_STATUS_ERROR);
            break;
    }

    auto snap = graph_ ? graph_->get_snapshot() : nullptr;
    Scratchpad* tls_scratch =
        (graph_ && graph_->num_nodes() > 0U)
            ? &ShortestPathEngine::thread_local_scratchpad(graph_->num_nodes())
            : nullptr;

    for (const auto& r : sol.routes) {
        auto* proto_route = response->add_routes();
        proto_route->set_vehicle_id(r.vehicle_id);
        proto_route->set_total_distance_meters(r.total_distance_meters);
        proto_route->set_total_duration_seconds(r.total_duration_seconds);
        proto_route->set_total_wait_seconds(r.total_wait_seconds);
        proto_route->set_total_penalty_cost(r.total_penalty_cost);

        std::vector<NodeCoord> route_coords;
        if (!r.schedule.empty() && graph_ && sp_engine_ && snap && tls_scratch != nullptr &&
            r.vehicle_index < vehicle_start_coords.size()) {
            uint32_t prev_node = graph_->find_nearest_node(vehicle_start_coords[r.vehicle_index]);
            for (const auto& sched : r.schedule) {
                if (sched.stop_index >= stop_coords.size()) continue;
                const uint32_t next_node = graph_->find_nearest_node(stop_coords[sched.stop_index]);
                const auto leg =
                    sp_engine_->reconstruct_path_coords(prev_node, next_node, *snap, *tls_scratch);
                const size_t start_offset = route_coords.empty() ? 0U : 1U;
                for (size_t k = start_offset; k < leg.size(); ++k) {
                    route_coords.push_back(leg[k]);
                }
                prev_node = next_node;
            }
            if (route_coords.size() >= 2U) {
                proto_route->set_encoded_polyline(encode_polyline5(route_coords));
            }
        }

        for (const auto& sched : r.schedule) {
            auto* proto_stop = proto_route->add_scheduled_stops();
            proto_stop->set_stop_id(sched.stop_id);
            proto_stop->set_estimated_arrival_unix(sched.arrival_unix);
            proto_stop->set_estimated_departure_unix(sched.departure_unix);
            proto_stop->set_slack_seconds(sched.forward_tw_slack_seconds);
            proto_stop->set_accumulated_load_kg(sched.accumulated_load_kg);
        }
    }

    for (const auto& uid : sol.unassigned_stop_ids) {
        response->add_unassigned_stop_ids(uid);
    }

    response->set_objective_cost(sol.objective_cost);
    response->set_solver_duration_ms(sol.solver_duration_ms);
    response->set_iterations_completed(sol.iterations_completed);
    response->set_error_message(sol.error_message);

    total_solved_requests_.fetch_add(1, std::memory_order_relaxed);
    cumulative_solve_duration_ms_.fetch_add(sol.solver_duration_ms, std::memory_order_relaxed);

    return grpc::Status::OK;
}

grpc::Status RoutingServiceImpl::UpdateTrafficMultipliers(
    grpc::ServerContext* context,
    const chronos::routing::v1::TrafficUpdateRequest* request,
    chronos::routing::v1::TrafficUpdateResponse* response) {
    if (request == nullptr || response == nullptr) {
        return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "Null request or response");
    }

    (void)extract_and_propagate_trace_id(context);
    const auto t0 = std::chrono::steady_clock::now();

    std::vector<EdgeMultiplierUpdate> updates;
    updates.reserve(static_cast<size_t>(request->edge_multipliers_size()));
    for (const auto& em : request->edge_multipliers()) {
        updates.push_back(EdgeMultiplierUpdate{em.edge_id(), em.speed_multiplier()});
    }

    const uint32_t updated =
        graph_->update_speed_multipliers(updates, request->timestamp_unix());

    const auto t1 = std::chrono::steady_clock::now();
    const int64_t micros = std::max<int64_t>(
        1, std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());

    response->set_batch_id(request->batch_id());
    response->set_success(true);
    response->set_edges_updated(static_cast<int32_t>(updated));
    response->set_update_latency_micros(micros);
    return grpc::Status::OK;
}

grpc::Status RoutingServiceImpl::ComputeDistanceMatrix(
    grpc::ServerContext* context,
    const chronos::routing::v1::MatrixRequest* request,
    chronos::routing::v1::MatrixResponse* response) {
    if (request == nullptr || response == nullptr) {
        return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "Null request or response");
    }

    (void)extract_and_propagate_trace_id(context);

    std::vector<NodeCoord> origins;
    origins.reserve(static_cast<size_t>(request->origins_size()));
    for (const auto& c : request->origins()) {
        origins.push_back(NodeCoord{c.latitude(), c.longitude()});
    }

    std::vector<NodeCoord> destinations;
    destinations.reserve(static_cast<size_t>(request->destinations_size()));
    for (const auto& c : request->destinations()) {
        destinations.push_back(NodeCoord{c.latitude(), c.longitude()});
    }

    auto snap = graph_->get_snapshot();
    MatrixResult mr = sp_engine_->compute_matrix_from_coords(
        origins, destinations, *snap, pool_.get());

    response->set_matrix_id(request->matrix_id());
    response->set_rows(mr.rows);
    response->set_cols(mr.cols);
    for (int64_t dur : mr.durations_ms) {
        response->add_durations_ms(dur);
    }
    for (int64_t dist : mr.distances_meters) {
        response->add_distances_meters(dist);
    }

    return grpc::Status::OK;
}

grpc::Status RoutingServiceImpl::CheckHealth(
    grpc::ServerContext* context,
    const chronos::routing::v1::HealthRequest* request,
    chronos::routing::v1::HealthResponse* response) {
    if (request == nullptr || response == nullptr) {
        return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "Null request or response");
    }

    (void)extract_and_propagate_trace_id(context);

    const int64_t total_reqs = total_solved_requests_.load(std::memory_order_relaxed);
    const int64_t total_ms = cumulative_solve_duration_ms_.load(std::memory_order_relaxed);
    const double avg_ms =
        (total_reqs > 0) ? (static_cast<double>(total_ms) / static_cast<double>(total_reqs)) : 0.0;

    response->set_healthy(true);
    response->set_active_workers(static_cast<int32_t>(pool_->num_workers()));
    response->set_total_solved_requests(total_reqs);
    response->set_average_solve_duration_ms(avg_ms);
    response->set_graph_nodes_count(static_cast<int64_t>(graph_->num_nodes()));
    response->set_graph_edges_count(static_cast<int64_t>(graph_->num_edges()));
    return grpc::Status::OK;
}

} // namespace chronos
