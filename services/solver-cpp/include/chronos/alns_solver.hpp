#pragma once

// ============================================================================
// [CO-AUTHORED] Module CPP-5a: Parallel Portfolio ALNS CVRPTW Solver
// Destroy/Repair, Regret-2, O(1) Forward TW Slack, 2-Opt/Or-Opt, & Atomic Bound
// ============================================================================

#include "chronos/chronos.hpp"
#include "chronos/csr_graph.hpp"
#include "chronos/shortest_path.hpp"
#include "chronos/thread_pool.hpp"

#include <atomic>
#include <cstdint>
#include <functional>
#include <span>
#include <stop_token>
#include <string>
#include <vector>

namespace chronos {

enum class StopKind : uint8_t {
    Unspecified = 0,
    Pickup = 1,
    Dropoff = 2,
    Depot = 3
};

struct AlnsStop {
    std::string stop_id;
    NodeCoord coord{};
    int64_t demand_kg{0};
    int64_t window_start_unix{0};
    int64_t window_end_unix{86400};
    int64_t service_duration_seconds{60};
    StopKind kind{StopKind::Dropoff};
    std::string paired_stop_id;
    int32_t priority{1};

    // Internal resolved indices populated before search
    int32_t paired_stop_index{-1};
    uint32_t matrix_index{0};
};

struct AlnsVehicle {
    std::string vehicle_id;
    int64_t max_weight_kg{1000};
    int64_t shift_start_unix{0};
    int64_t shift_end_unix{86400};
    NodeCoord start_coord{};
    NodeCoord end_coord{};
    int32_t max_stops{100};

    // Internal resolved matrix indices populated before search
    uint32_t start_matrix_index{0};
    uint32_t end_matrix_index{0};
};

struct AlnsConfig {
    int64_t deadline_ms{kDefaultSolverDeadlineMs};
    uint32_t num_search_trajectories{4};
    double late_penalty_per_second{10.0};
    double unassigned_stop_penalty{100000.0};
    bool allow_unassigned_stops{true};
    uint32_t max_iterations_per_trajectory{300};
    bool hard_time_windows{false};
};

struct RouteStopSchedule {
    uint32_t stop_index{0};
    std::string stop_id;
    int64_t arrival_unix{0};
    int64_t departure_unix{0};
    int64_t wait_seconds{0};
    int64_t late_seconds{0};
    // Savelsbergh O(1) forward time-window slack: maximum shift in departure time
    // at this stop that does not cause any downstream stop on the route to violate
    // its window_end_unix.
    int64_t forward_tw_slack_seconds{0};
    int64_t accumulated_load_kg{0};
};

struct PlannedVehicleRoute {
    uint32_t vehicle_index{0};
    std::string vehicle_id;
    std::vector<uint32_t> stop_indices;
    std::vector<RouteStopSchedule> schedule;
    int64_t total_distance_meters{0};
    int64_t total_duration_seconds{0};
    int64_t total_wait_seconds{0};
    int64_t total_penalty_cost{0};
    double route_cost{0.0};
    bool feasible{true};
};

enum class AlnsStatus : uint8_t {
    Unspecified = 0,
    Optimal = 1,
    Feasible = 2,
    TimeoutBestEffort = 3,
    Infeasible = 4,
    Error = 5
};

struct AlnsSolution {
    AlnsStatus status{AlnsStatus::Unspecified};
    std::vector<PlannedVehicleRoute> routes;
    std::vector<uint32_t> unassigned_stop_indices;
    std::vector<std::string> unassigned_stop_ids;
    double objective_cost{0.0};
    int64_t solver_duration_ms{0};
    int32_t iterations_completed{0};
    bool deadline_exceeded{false};
    std::string error_message;
};

class ParallelAlnsSolver {
public:
    using CancelCallback = std::function<bool()>;

    ParallelAlnsSolver(std::shared_ptr<const CsrGraph> graph = nullptr,
                       std::shared_ptr<const ShortestPathEngine> sp_engine = nullptr,
                       ThreadPool* pool = nullptr);

    [[nodiscard]] AlnsSolution solve(
        std::vector<AlnsVehicle> vehicles,
        std::vector<AlnsStop> stops,
        const AlnsConfig& config = {},
        std::span<const int64_t> precomputed_duration_matrix_ms = {},
        int32_t matrix_dimension = 0,
        std::stop_token stop_token = {},
        CancelCallback is_cancelled = {});

    // Evaluate a single vehicle route and compute O(1) forward time-window slack
    // (`forward_tw_slack_seconds`) and load profile.
    static bool evaluate_route(
        PlannedVehicleRoute& route,
        const AlnsVehicle& vehicle,
        std::span<const AlnsStop> stops,
        std::span<const int64_t> duration_matrix_ms,
        std::span<const int64_t> distance_matrix_m,
        uint32_t matrix_dim,
        const AlnsConfig& config);

    // O(1) check whether a time shift `delta_seconds` at stop position `pos` in `route`
    // is feasible without violating downstream time windows, using precomputed
    // Savelsbergh `forward_tw_slack_seconds`.
    [[nodiscard]] static bool check_forward_slack_o1(
        const PlannedVehicleRoute& route,
        size_t pos,
        int64_t delta_seconds) noexcept {
        if (pos >= route.schedule.size()) return true;
        return delta_seconds <= route.schedule[pos].forward_tw_slack_seconds;
    }

private:
    std::shared_ptr<const CsrGraph> graph_;
    std::shared_ptr<const ShortestPathEngine> sp_engine_;
    ThreadPool* pool_{nullptr};
};

} // namespace chronos
