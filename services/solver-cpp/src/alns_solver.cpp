#include "chronos/alns_solver.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <future>
#include <limits>
#include <mutex>
#include <numeric>
#include <random>
#include <unordered_map>
#include <unordered_set>

namespace chronos {

namespace {

inline int64_t matrix_lookup(std::span<const int64_t> mat, uint32_t dim,
                             uint32_t r, uint32_t c) noexcept {
    if (r == c || dim == 0U || r >= dim || c >= dim) return 0;
    const size_t idx = static_cast<size_t>(r) * static_cast<size_t>(dim) + static_cast<size_t>(c);
    if (idx >= mat.size()) return 0;
    return mat[idx];
}

} // namespace

ParallelAlnsSolver::ParallelAlnsSolver(std::shared_ptr<const CsrGraph> graph,
                                       std::shared_ptr<const ShortestPathEngine> sp_engine,
                                       ThreadPool* pool)
    : graph_(std::move(graph)),
      sp_engine_(std::move(sp_engine)),
      pool_(pool) {}

bool ParallelAlnsSolver::evaluate_route(
    PlannedVehicleRoute& route,
    const AlnsVehicle& vehicle,
    std::span<const AlnsStop> stops,
    std::span<const int64_t> duration_matrix_ms,
    std::span<const int64_t> distance_matrix_m,
    uint32_t matrix_dim,
    const AlnsConfig& config) {
    route.vehicle_id = vehicle.vehicle_id;
    route.schedule.clear();
    route.total_distance_meters = 0;
    route.total_duration_seconds = 0;
    route.total_wait_seconds = 0;
    route.total_penalty_cost = 0;
    route.route_cost = 0.0;
    route.feasible = true;

    if (route.stop_indices.empty()) {
        return true;
    }

    if (vehicle.max_stops > 0 &&
        static_cast<int32_t>(route.stop_indices.size()) > vehicle.max_stops) {
        route.feasible = false;
    }

    // Track position of each stop on this route to verify pickup-before-dropoff precedence
    std::unordered_map<uint32_t, size_t> pos_in_route;
    pos_in_route.reserve(route.stop_indices.size());
    for (size_t pos = 0; pos < route.stop_indices.size(); ++pos) {
        pos_in_route[route.stop_indices[pos]] = pos;
    }

    // Compute initial depot load for unpaired dropoffs on this route
    int64_t initial_depot_load = 0;
    for (uint32_t s_idx : route.stop_indices) {
        const auto& stop = stops[s_idx];
        const int32_t partner = stop.paired_stop_index;
        if (partner >= 0) {
            auto partner_it = pos_in_route.find(static_cast<uint32_t>(partner));
            if (partner_it == pos_in_route.end()) {
                route.feasible = false;
            } else if (stop.kind == StopKind::Pickup &&
                       pos_in_route[s_idx] >= partner_it->second) {
                route.feasible = false;
            } else if (stop.kind == StopKind::Dropoff &&
                       pos_in_route[s_idx] <= partner_it->second) {
                route.feasible = false;
            }
        } else if (stop.kind != StopKind::Pickup) {
            initial_depot_load += std::max<int64_t>(0, stop.demand_kg);
        }
    }

    if (vehicle.max_weight_kg > 0 && initial_depot_load > vehicle.max_weight_kg) {
        route.feasible = false;
    }

    int64_t running_load = 0;
    int64_t onboard_load = initial_depot_load;
    int64_t cur_time = vehicle.shift_start_unix;
    uint32_t prev_mat_idx = vehicle.start_matrix_index;

    route.schedule.resize(route.stop_indices.size());

    for (size_t k = 0; k < route.stop_indices.size(); ++k) {
        const uint32_t s_idx = route.stop_indices[k];
        const auto& stop = stops[s_idx];

        const int64_t leg_ms = matrix_lookup(
            duration_matrix_ms, matrix_dim, prev_mat_idx, stop.matrix_index);
        const int64_t leg_dist = matrix_lookup(
            distance_matrix_m, matrix_dim, prev_mat_idx, stop.matrix_index);
        const int64_t leg_sec = std::max<int64_t>(0, (leg_ms + 500) / 1000);

        const int64_t arrival = cur_time + leg_sec;
        const int64_t wait_sec =
            (stop.window_start_unix > arrival) ? (stop.window_start_unix - arrival) : 0;
        const int64_t start_service = arrival + wait_sec;

        int64_t late_sec = 0;
        if (stop.window_end_unix > 0 && start_service > stop.window_end_unix) {
            late_sec = start_service - stop.window_end_unix;
            if (config.hard_time_windows) {
                route.feasible = false;
            }
        }

        const int64_t departure =
            start_service + std::max<int64_t>(0, stop.service_duration_seconds);

        if (stop.paired_stop_index >= 0) {
            if (stop.kind == StopKind::Pickup) {
                onboard_load += std::max<int64_t>(0, stop.demand_kg);
                running_load += std::max<int64_t>(0, stop.demand_kg);
            } else if (stop.kind == StopKind::Dropoff) {
                onboard_load = std::max<int64_t>(
                    0, onboard_load - std::max<int64_t>(0, stop.demand_kg));
            }
        } else {
            running_load += std::max<int64_t>(0, stop.demand_kg);
        }

        const int64_t check_load = std::max(running_load, onboard_load);
        if (vehicle.max_weight_kg > 0 && check_load > vehicle.max_weight_kg) {
            route.feasible = false;
        }

        route.schedule[k] = RouteStopSchedule{
            s_idx,
            stop.stop_id,
            arrival,
            departure,
            wait_sec,
            late_sec,
            0, // forward_tw_slack_seconds filled in backward pass below
            running_load,
        };

        route.total_distance_meters += leg_dist;
        route.total_duration_seconds += leg_sec + wait_sec +
                                        std::max<int64_t>(0, stop.service_duration_seconds);
        route.total_wait_seconds += wait_sec;
        const int64_t stop_penalty = static_cast<int64_t>(std::llround(
            static_cast<double>(late_sec) * std::max(1.0, config.late_penalty_per_second)));
        route.total_penalty_cost += stop_penalty;

        cur_time = departure;
        prev_mat_idx = stop.matrix_index;
    }

    // Return leg to vehicle end location
    const int64_t end_leg_ms = matrix_lookup(
        duration_matrix_ms, matrix_dim, prev_mat_idx, vehicle.end_matrix_index);
    const int64_t end_leg_dist = matrix_lookup(
        distance_matrix_m, matrix_dim, prev_mat_idx, vehicle.end_matrix_index);
    const int64_t end_leg_sec = std::max<int64_t>(0, (end_leg_ms + 500) / 1000);
    route.total_distance_meters += end_leg_dist;
    route.total_duration_seconds += end_leg_sec;

    const int64_t finish_unix = cur_time + end_leg_sec;
    if (vehicle.shift_end_unix > vehicle.shift_start_unix &&
        finish_unix > vehicle.shift_end_unix) {
        const int64_t overtime_sec = finish_unix - vehicle.shift_end_unix;
        route.total_penalty_cost += static_cast<int64_t>(std::llround(
            static_cast<double>(overtime_sec) * std::max(1.0, config.late_penalty_per_second)));
    }

    // Savelsbergh backward pass for O(1) forward time-window slack
    const size_t m = route.schedule.size();
    for (size_t rev = 0; rev < m; ++rev) {
        const size_t k = m - 1U - rev;
        const auto& stop = stops[route.schedule[k].stop_index];
        const int64_t start_service =
            route.schedule[k].arrival_unix + route.schedule[k].wait_seconds;
        const int64_t local_slack =
            (stop.window_end_unix > 0)
                ? std::max<int64_t>(0, stop.window_end_unix - start_service)
                : 86400;

        if (k + 1U == m) {
            route.schedule[k].forward_tw_slack_seconds = local_slack;
        } else {
            const int64_t downstream_capacity =
                route.schedule[k + 1U].wait_seconds +
                route.schedule[k + 1U].forward_tw_slack_seconds;
            route.schedule[k].forward_tw_slack_seconds =
                std::min(local_slack, downstream_capacity);
        }
    }

    // Composite route objective: travel duration + distance weighting + waiting + TW penalty
    route.route_cost =
        static_cast<double>(route.total_duration_seconds) +
        0.05 * static_cast<double>(route.total_distance_meters) +
        0.2 * static_cast<double>(route.total_wait_seconds) +
        static_cast<double>(route.total_penalty_cost) +
        (route.feasible ? 0.0 : 1e7);

    return route.feasible;
}

AlnsSolution ParallelAlnsSolver::solve(
    std::vector<AlnsVehicle> vehicles,
    std::vector<AlnsStop> stops,
    const AlnsConfig& config,
    std::span<const int64_t> precomputed_duration_matrix_ms,
    int32_t matrix_dimension,
    std::stop_token stop_token,
    CancelCallback is_cancelled) {
    const auto start_tp = std::chrono::steady_clock::now();
    const int64_t effective_budget_ms =
        (config.deadline_ms > 0) ? config.deadline_ms : kDefaultSolverDeadlineMs;
    const auto deadline_tp = start_tp + std::chrono::milliseconds(effective_budget_ms);

    AlnsSolution empty_sol;
    if (stops.empty()) {
        empty_sol.status = AlnsStatus::Optimal;
        empty_sol.routes.resize(vehicles.size());
        for (size_t v = 0; v < vehicles.size(); ++v) {
            empty_sol.routes[v].vehicle_index = static_cast<uint32_t>(v);
            empty_sol.routes[v].vehicle_id = vehicles[v].vehicle_id;
        }
        return empty_sol;
    }
    if (vehicles.empty()) {
        empty_sol.status = AlnsStatus::Infeasible;
        empty_sol.error_message = "No vehicles provided for non-empty stop list";
        for (uint32_t i = 0; i < stops.size(); ++i) {
            empty_sol.unassigned_stop_indices.push_back(i);
            empty_sol.unassigned_stop_ids.push_back(stops[i].stop_id);
        }
        return empty_sol;
    }

    // 1. Resolve pickup-before-dropoff pairs by stop_id
    std::unordered_map<std::string, uint32_t> id_to_idx;
    id_to_idx.reserve(stops.size());
    for (uint32_t i = 0; i < stops.size(); ++i) {
        id_to_idx[stops[i].stop_id] = i;
        stops[i].paired_stop_index = -1;
    }
    for (uint32_t i = 0; i < stops.size(); ++i) {
        if (!stops[i].paired_stop_id.empty()) {
            auto it = id_to_idx.find(stops[i].paired_stop_id);
            if (it != id_to_idx.end() && it->second != i) {
                const uint32_t j = it->second;
                stops[i].paired_stop_index = static_cast<int32_t>(j);
                stops[j].paired_stop_index = static_cast<int32_t>(i);
                if (stops[i].kind != StopKind::Pickup && stops[j].kind != StopKind::Pickup) {
                    if (i < j) {
                        stops[i].kind = StopKind::Pickup;
                        stops[j].kind = StopKind::Dropoff;
                    } else {
                        stops[j].kind = StopKind::Pickup;
                        stops[i].kind = StopKind::Dropoff;
                    }
                } else if (stops[i].kind == StopKind::Pickup) {
                    stops[j].kind = StopKind::Dropoff;
                } else if (stops[j].kind == StopKind::Pickup) {
                    stops[i].kind = StopKind::Dropoff;
                }
            }
        }
    }

    // 2. Build or bind travel-time & distance matrices
    const uint32_t num_stops = static_cast<uint32_t>(stops.size());
    const uint32_t num_vehicles = static_cast<uint32_t>(vehicles.size());
    const uint32_t total_locs = num_stops + 2U * num_vehicles;

    std::vector<NodeCoord> all_coords(total_locs);
    for (uint32_t i = 0; i < num_stops; ++i) {
        stops[i].matrix_index = i;
        all_coords[i] = stops[i].coord;
    }
    for (uint32_t v = 0; v < num_vehicles; ++v) {
        const uint32_t start_idx = num_stops + 2U * v;
        const uint32_t end_idx = num_stops + 2U * v + 1U;
        vehicles[v].start_matrix_index = start_idx;
        vehicles[v].end_matrix_index = end_idx;
        all_coords[start_idx] = vehicles[v].start_coord;
        all_coords[end_idx] =
            (vehicles[v].end_coord.latitude == 0.0 && vehicles[v].end_coord.longitude == 0.0)
                ? vehicles[v].start_coord
                : vehicles[v].end_coord;
    }

    std::vector<int64_t> duration_mat_ms(static_cast<size_t>(total_locs) * total_locs, 0);
    std::vector<int64_t> distance_mat_m(static_cast<size_t>(total_locs) * total_locs, 0);

    if (sp_engine_ && graph_) {
        auto snap = graph_->get_snapshot();
        if (snap) {
            MatrixResult mr = sp_engine_->compute_matrix_from_coords(
                all_coords, all_coords, *snap, pool_);
            if (mr.durations_ms.size() == duration_mat_ms.size()) {
                duration_mat_ms = std::move(mr.durations_ms);
                distance_mat_m = std::move(mr.distances_meters);
            }
        }
    } else {
        for (uint32_t i = 0; i < total_locs; ++i) {
            for (uint32_t j = 0; j < total_locs; ++j) {
                if (i == j) continue;
                const double dist_m = CsrGraph::haversine_meters(all_coords[i], all_coords[j]);
                const int64_t dm = std::max<int64_t>(10, static_cast<int64_t>(std::llround(dist_m)));
                const int64_t dur_ms =
                    std::max<int64_t>(100, static_cast<int64_t>(std::llround((dist_m / 12.5) * 1000.0)));
                const size_t idx = static_cast<size_t>(i) * total_locs + j;
                distance_mat_m[idx] = dm;
                duration_mat_ms[idx] = dur_ms;
            }
        }
    }

    // Overlay optional precomputed duration matrix if supplied by request
    if (!precomputed_duration_matrix_ms.empty() && matrix_dimension > 0) {
        const uint32_t pdim = static_cast<uint32_t>(matrix_dimension);
        if (precomputed_duration_matrix_ms.size() >= static_cast<size_t>(pdim) * pdim) {
            const uint32_t copy_dim = std::min(pdim, total_locs);
            for (uint32_t r = 0; r < copy_dim; ++r) {
                for (uint32_t c = 0; c < copy_dim; ++c) {
                    const int64_t val =
                        precomputed_duration_matrix_ms[static_cast<size_t>(r) * pdim + c];
                    duration_mat_ms[static_cast<size_t>(r) * total_locs + c] = val;
                    if (distance_mat_m[static_cast<size_t>(r) * total_locs + c] == 0 && r != c) {
                        distance_mat_m[static_cast<size_t>(r) * total_locs + c] =
                            std::max<int64_t>(1, (val * 12) / 1000);
                    }
                }
            }
        }
    }

    auto should_abort = [&]() noexcept -> bool {
        if (stop_token.stop_requested()) return true;
        if (is_cancelled && is_cancelled()) return true;
        if (std::chrono::steady_clock::now() >= deadline_tp) return true;
        return false;
    };

    // Helper: evaluate full candidate solution cost
    auto compute_solution_cost = [&](AlnsSolution& sol) -> double {
        double total = 0.0;
        bool all_routes_feasible = true;
        for (size_t v = 0; v < vehicles.size(); ++v) {
            sol.routes[v].vehicle_index = static_cast<uint32_t>(v);
            const bool ok = evaluate_route(
                sol.routes[v], vehicles[v], stops,
                duration_mat_ms, distance_mat_m, total_locs, config);
            if (!ok) all_routes_feasible = false;
            total += sol.routes[v].route_cost;
        }
        total += static_cast<double>(sol.unassigned_stop_indices.size()) *
                 config.unassigned_stop_penalty;
        sol.objective_cost = total;
        sol.status = (all_routes_feasible && sol.unassigned_stop_indices.empty())
                         ? AlnsStatus::Feasible
                         : (config.allow_unassigned_stops && all_routes_feasible
                                ? AlnsStatus::Feasible
                                : AlnsStatus::Infeasible);
        return total;
    };

    // Helper: try inserting a single stop or a (pickup, dropoff) pair into a vehicle route
    auto best_insertion_for_unit = [&](const PlannedVehicleRoute& base_route,
                                       const AlnsVehicle& vehicle,
                                       uint32_t primary_stop,
                                       int32_t drop_stop_opt,
                                       PlannedVehicleRoute& out_best_route,
                                       double& out_delta_cost) -> bool {
        out_delta_cost = std::numeric_limits<double>::max();
        bool found = false;
        const size_t len = base_route.stop_indices.size();

        if (drop_stop_opt < 0) {
            // Single stop insertion
            for (size_t pos = 0; pos <= len; ++pos) {
                // Quick O(1) forward slack pre-filter when inserting before existing stop
                if (config.hard_time_windows && pos < len) {
                    const uint32_t prev_m =
                        (pos == 0U)
                            ? vehicle.start_matrix_index
                            : stops[base_route.stop_indices[pos - 1U]].matrix_index;
                    const uint32_t next_m = stops[base_route.stop_indices[pos]].matrix_index;
                    const uint32_t ins_m = stops[primary_stop].matrix_index;
                    const int64_t detour_sec =
                        (matrix_lookup(duration_mat_ms, total_locs, prev_m, ins_m) +
                         matrix_lookup(duration_mat_ms, total_locs, ins_m, next_m) -
                         matrix_lookup(duration_mat_ms, total_locs, prev_m, next_m)) /
                            1000 +
                        stops[primary_stop].service_duration_seconds;
                    if (!check_forward_slack_o1(base_route, pos, detour_sec)) {
                        continue;
                    }
                }

                PlannedVehicleRoute cand = base_route;
                cand.stop_indices.clear();
                cand.stop_indices.reserve(len + 1U);
                for (size_t k = 0; k < pos; ++k) {
                    cand.stop_indices.push_back(base_route.stop_indices[k]);
                }
                cand.stop_indices.push_back(primary_stop);
                for (size_t k = pos; k < len; ++k) {
                    cand.stop_indices.push_back(base_route.stop_indices[k]);
                }
                if (evaluate_route(cand, vehicle, stops, duration_mat_ms,
                                   distance_mat_m, total_locs, config)) {
                    const double delta = cand.route_cost - base_route.route_cost;
                    if (delta < out_delta_cost) {
                        out_delta_cost = delta;
                        out_best_route = std::move(cand);
                        found = true;
                    }
                }
            }
        } else {
            // Paired (pickup, dropoff) insertion: pickup at pos_p, dropoff at pos_d > pos_p
            const uint32_t drop_stop = static_cast<uint32_t>(drop_stop_opt);
            for (size_t pos_p = 0; pos_p <= len; ++pos_p) {
                for (size_t pos_d = pos_p + 1U; pos_d <= len + 1U; ++pos_d) {
                    PlannedVehicleRoute cand = base_route;
                    cand.stop_indices.clear();
                    cand.stop_indices.reserve(len + 2U);
                    for (size_t k = 0; k <= len + 1U; ++k) {
                        if (k == pos_p) {
                            cand.stop_indices.push_back(primary_stop);
                        } else if (k == pos_d) {
                            cand.stop_indices.push_back(drop_stop);
                        } else {
                            const size_t src_idx =
                                k - (k > pos_p ? 1U : 0U) - (k > pos_d ? 1U : 0U);
                            if (src_idx < len) {
                                cand.stop_indices.push_back(base_route.stop_indices[src_idx]);
                            }
                        }
                    }
                    if (evaluate_route(cand, vehicle, stops, duration_mat_ms,
                                       distance_mat_m, total_locs, config)) {
                        const double delta = cand.route_cost - base_route.route_cost;
                        if (delta < out_delta_cost) {
                            out_delta_cost = delta;
                            out_best_route = std::move(cand);
                            found = true;
                        }
                    }
                }
            }
        }
        return found;
    };

    // Repair operator (mode 0 = Greedy Insertion, mode 1 = Regret-2 Insertion)
    auto repair_solution = [&](AlnsSolution& sol, int mode, std::mt19937_64& rng) {
        // Group unassigned stops into independent units: single stops or (pickup, dropoff) pairs
        struct RepairUnit {
            uint32_t primary{0};
            int32_t secondary{-1};
        };
        std::vector<RepairUnit> units;
        std::unordered_set<uint32_t> seen;
        for (uint32_t s_idx : sol.unassigned_stop_indices) {
            if (seen.contains(s_idx)) continue;
            const int32_t partner = stops[s_idx].paired_stop_index;
            if (partner >= 0) {
                const uint32_t p_idx = static_cast<uint32_t>(partner);
                seen.insert(s_idx);
                seen.insert(p_idx);
                if (stops[s_idx].kind == StopKind::Pickup) {
                    units.push_back(RepairUnit{s_idx, static_cast<int32_t>(p_idx)});
                } else {
                    units.push_back(RepairUnit{p_idx, static_cast<int32_t>(s_idx)});
                }
            } else {
                seen.insert(s_idx);
                units.push_back(RepairUnit{s_idx, -1});
            }
        }

        // Order units initially by earliest window_end_unix (EDF) with slight noise
        if (mode == 0) {
            std::sort(units.begin(), units.end(), [&](const RepairUnit& a, const RepairUnit& b) {
                return stops[a.primary].window_end_unix < stops[b.primary].window_end_unix;
            });
        }

        std::vector<uint32_t> remaining_unassigned;
        std::uniform_real_distribution<double> noise_dist(0.97, 1.03);

        while (!units.empty()) {
            size_t chosen_u = 0;
            uint32_t chosen_veh = 0;
            PlannedVehicleRoute chosen_route;
            bool any_feasible = false;

            if (mode == 0) {
                // Greedy insertion across vehicles for the front unit
                double best_delta = std::numeric_limits<double>::max();
                const auto& u = units.front();
                for (uint32_t v = 0; v < num_vehicles; ++v) {
                    PlannedVehicleRoute cand_route;
                    double delta = 0.0;
                    if (best_insertion_for_unit(sol.routes[v], vehicles[v],
                                                u.primary, u.secondary,
                                                cand_route, delta)) {
                        const double noisy_delta = delta * noise_dist(rng);
                        if (noisy_delta < best_delta) {
                            best_delta = noisy_delta;
                            chosen_veh = v;
                            chosen_route = std::move(cand_route);
                            any_feasible = true;
                        }
                    }
                }
                chosen_u = 0;
            } else {
                // Regret-2 insertion across all remaining units
                double best_regret_score = -std::numeric_limits<double>::max();
                for (size_t u_idx = 0; u_idx < units.size(); ++u_idx) {
                    const auto& u = units[u_idx];
                    double first_best = std::numeric_limits<double>::max();
                    double second_best = std::numeric_limits<double>::max();
                    uint32_t best_v = 0;
                    PlannedVehicleRoute best_r;
                    bool unit_ok = false;

                    for (uint32_t v = 0; v < num_vehicles; ++v) {
                        PlannedVehicleRoute cand_route;
                        double delta = 0.0;
                        if (best_insertion_for_unit(sol.routes[v], vehicles[v],
                                                    u.primary, u.secondary,
                                                    cand_route, delta)) {
                            unit_ok = true;
                            if (delta < first_best) {
                                second_best = first_best;
                                first_best = delta;
                                best_v = v;
                                best_r = std::move(cand_route);
                            } else if (delta < second_best) {
                                second_best = delta;
                            }
                        }
                    }

                    if (unit_ok) {
                        const double regret =
                            (second_best < std::numeric_limits<double>::max() * 0.5)
                                ? (second_best - first_best)
                                : (1e5 - first_best);
                        if (!any_feasible || regret > best_regret_score) {
                            best_regret_score = regret;
                            chosen_u = u_idx;
                            chosen_veh = best_v;
                            chosen_route = std::move(best_r);
                            any_feasible = true;
                        }
                    }
                }
            }

            if (any_feasible) {
                sol.routes[chosen_veh] = std::move(chosen_route);
                units.erase(units.begin() + static_cast<std::ptrdiff_t>(chosen_u));
            } else {
                // Unit at chosen_u could not be feasibly inserted
                const auto& failed = units[chosen_u];
                remaining_unassigned.push_back(failed.primary);
                if (failed.secondary >= 0) {
                    remaining_unassigned.push_back(static_cast<uint32_t>(failed.secondary));
                }
                units.erase(units.begin() + static_cast<std::ptrdiff_t>(chosen_u));
            }
        }

        sol.unassigned_stop_indices = std::move(remaining_unassigned);
        compute_solution_cost(sol);
    };

    // Destroy operator (mode 0 = Random, mode 1 = Worst-Cost, mode 2 = Shaw/Relatedness)
    auto destroy_solution = [&](AlnsSolution& sol, int mode, std::mt19937_64& rng) {
        std::vector<std::pair<uint32_t, uint32_t>> assigned; // (vehicle_idx, stop_idx)
        for (uint32_t v = 0; v < num_vehicles; ++v) {
            for (uint32_t s_idx : sol.routes[v].stop_indices) {
                // Only add canonical representative for paired stops
                if (stops[s_idx].paired_stop_index >= 0 &&
                    stops[s_idx].kind == StopKind::Dropoff) {
                    continue;
                }
                assigned.push_back({v, s_idx});
            }
        }
        if (assigned.empty()) return;

        const size_t max_remove = std::clamp<size_t>(assigned.size() / 3U + 1U, 1U, 8U);
        std::uniform_int_distribution<size_t> count_dist(1U, max_remove);
        const size_t target_remove = count_dist(rng);

        std::unordered_set<uint32_t> to_remove;
        auto mark_remove = [&](uint32_t s_idx) {
            to_remove.insert(s_idx);
            if (stops[s_idx].paired_stop_index >= 0) {
                to_remove.insert(static_cast<uint32_t>(stops[s_idx].paired_stop_index));
            }
        };

        if (mode == 0) {
            // Random Destroy
            std::shuffle(assigned.begin(), assigned.end(), rng);
            for (size_t i = 0; i < std::min(target_remove, assigned.size()); ++i) {
                mark_remove(assigned[i].second);
            }
        } else if (mode == 1) {
            // Worst-Cost Destroy
            struct StopMarginal {
                double saving{0.0};
                uint32_t stop_idx{0};
            };
            std::vector<StopMarginal> marginals;
            marginals.reserve(assigned.size());

            for (const auto& [v, s_idx] : assigned) {
                const auto& r = sol.routes[v];
                PlannedVehicleRoute reduced = r;
                const int32_t partner = stops[s_idx].paired_stop_index;
                std::erase_if(reduced.stop_indices, [&](uint32_t x) {
                    return x == s_idx ||
                           (partner >= 0 && x == static_cast<uint32_t>(partner));
                });
                evaluate_route(reduced, vehicles[v], stops, duration_mat_ms,
                               distance_mat_m, total_locs, config);
                marginals.push_back(StopMarginal{r.route_cost - reduced.route_cost, s_idx});
            }
            std::sort(marginals.begin(), marginals.end(),
                      [](const StopMarginal& a, const StopMarginal& b) {
                          return a.saving > b.saving;
                      });
            for (size_t i = 0; i < std::min(target_remove, marginals.size()); ++i) {
                mark_remove(marginals[i].stop_idx);
            }
        } else {
            // Shaw (Relatedness) Destroy: spatial + time-window + demand similarity
            std::uniform_int_distribution<size_t> pick_seed(0U, assigned.size() - 1U);
            const uint32_t seed_stop = assigned[pick_seed(rng)].second;
            mark_remove(seed_stop);

            struct RelatednessItem {
                double score{0.0};
                uint32_t stop_idx{0};
            };
            std::vector<RelatednessItem> rel;
            rel.reserve(assigned.size());
            for (const auto& [v, s_idx] : assigned) {
                (void)v;
                if (s_idx == seed_stop) continue;
                const double spatial_m = static_cast<double>(matrix_lookup(
                    distance_mat_m, total_locs,
                    stops[seed_stop].matrix_index, stops[s_idx].matrix_index));
                const double tw_diff = static_cast<double>(std::abs(
                    stops[seed_stop].window_start_unix - stops[s_idx].window_start_unix));
                const double dem_diff = static_cast<double>(std::abs(
                    stops[seed_stop].demand_kg - stops[s_idx].demand_kg));
                const double score = 1.0 * spatial_m + 2.0 * tw_diff + 15.0 * dem_diff;
                rel.push_back(RelatednessItem{score, s_idx});
            }
            std::sort(rel.begin(), rel.end(),
                      [](const RelatednessItem& a, const RelatednessItem& b) {
                          return a.score < b.score;
                      });
            for (size_t i = 0; i + 1U < target_remove && i < rel.size(); ++i) {
                mark_remove(rel[i].stop_idx);
            }
        }

        for (uint32_t v = 0; v < num_vehicles; ++v) {
            auto& vec = sol.routes[v].stop_indices;
            const size_t before = vec.size();
            std::erase_if(vec, [&](uint32_t x) { return to_remove.contains(x); });
            if (vec.size() != before) {
                evaluate_route(sol.routes[v], vehicles[v], stops, duration_mat_ms,
                               distance_mat_m, total_locs, config);
            }
        }
        for (uint32_t rem : to_remove) {
            sol.unassigned_stop_indices.push_back(rem);
        }
    };

    // Intra-route 2-Opt & Or-Opt local search
    auto local_search_intensify = [&](AlnsSolution& sol) {
        for (uint32_t v = 0; v < num_vehicles; ++v) {
            auto& route = sol.routes[v];
            if (route.stop_indices.size() < 2U) continue;

            // 1. Intra-route 2-Opt segment reversal
            bool improved = true;
            while (improved) {
                improved = false;
                const size_t m = route.stop_indices.size();
                for (size_t i = 0; i + 1U < m; ++i) {
                    for (size_t j = i + 1U; j < m; ++j) {
                        PlannedVehicleRoute cand = route;
                        std::reverse(
                            cand.stop_indices.begin() + static_cast<std::ptrdiff_t>(i),
                            cand.stop_indices.begin() + static_cast<std::ptrdiff_t>(j + 1U));
                        if (evaluate_route(cand, vehicles[v], stops, duration_mat_ms,
                                           distance_mat_m, total_locs, config) &&
                            cand.route_cost + 1e-6 < route.route_cost) {
                            route = std::move(cand);
                            improved = true;
                            break;
                        }
                    }
                    if (improved) break;
                }
            }

            // 2. Intra-route Or-Opt (single-stop relocation)
            const size_t m = route.stop_indices.size();
            for (size_t i = 0; i < m; ++i) {
                const uint32_t moved = route.stop_indices[i];
                for (size_t dst = 0; dst < m; ++dst) {
                    if (dst == i) continue;
                    PlannedVehicleRoute cand = route;
                    cand.stop_indices.erase(
                        cand.stop_indices.begin() + static_cast<std::ptrdiff_t>(i));
                    cand.stop_indices.insert(
                        cand.stop_indices.begin() + static_cast<std::ptrdiff_t>(dst),
                        moved);
                    if (evaluate_route(cand, vehicles[v], stops, duration_mat_ms,
                                       distance_mat_m, total_locs, config) &&
                        cand.route_cost + 1e-6 < route.route_cost) {
                        route = std::move(cand);
                        break;
                    }
                }
            }
        }
        compute_solution_cost(sol);
    };

    // 3. Construct initial seed solution using Regret-2 insertion
    AlnsSolution initial_sol;
    initial_sol.routes.resize(num_vehicles);
    for (uint32_t v = 0; v < num_vehicles; ++v) {
        initial_sol.routes[v].vehicle_index = v;
        initial_sol.routes[v].vehicle_id = vehicles[v].vehicle_id;
    }
    initial_sol.unassigned_stop_indices.resize(num_stops);
    std::iota(initial_sol.unassigned_stop_indices.begin(),
              initial_sol.unassigned_stop_indices.end(), 0U);

    {
        std::mt19937_64 init_rng(0xC0FFEE123456ULL);
        repair_solution(initial_sol, 1, init_rng);
        local_search_intensify(initial_sol);
    }

    // Shared upper bound across all parallel ALNS trajectories
    std::atomic<double> best_cost{initial_sol.objective_cost};
    std::mutex best_sol_mutex;
    AlnsSolution best_sol = initial_sol;
    std::atomic<int32_t> total_iterations{0};
    std::atomic<bool> any_timeout{false};

    // Check if deadline already expired before launching trajectories
    if (should_abort() || config.deadline_ms <= 0) {
        any_timeout.store(true, std::memory_order_release);
    }

    const uint32_t num_trajectories = std::max<uint32_t>(1U, config.num_search_trajectories);
    std::vector<WorkerState> local_states;
    local_states.reserve(num_trajectories);
    for (uint32_t t = 0; t < num_trajectories; ++t) {
        local_states.emplace_back(t, 0x9E3779B97F4A7C15ULL + static_cast<uint64_t>(t) * 1013ULL);
    }

    auto run_trajectory = [&](uint32_t traj_id, std::stop_token worker_st) {
        WorkerState& wstate = local_states[traj_id];
        AlnsSolution current_sol = initial_sol;

        // Adaptive operator weights: 3 destroy ops, 2 repair ops
        std::array<double, 3> destroy_weights{1.0, 1.0, 1.0};
        std::array<double, 2> repair_weights{1.0, 1.2};
        double temperature = std::max(10.0, 0.05 * current_sol.objective_cost);
        constexpr double kCoolingRate = 0.985;
        std::uniform_real_distribution<double> unit_dist(0.0, 1.0);

        for (uint32_t iter = 0; iter < config.max_iterations_per_trajectory; ++iter) {
            if (worker_st.stop_requested() || should_abort()) {
                any_timeout.store(true, std::memory_order_release);
                break;
            }

            ++wstate.iterations_completed;
            total_iterations.fetch_add(1, std::memory_order_relaxed);

            // Roulette-wheel selection of destroy and repair operators
            const double d_sum = destroy_weights[0] + destroy_weights[1] + destroy_weights[2];
            const double d_pick = unit_dist(wstate.prng) * d_sum;
            const int d_op = (d_pick < destroy_weights[0])
                                 ? 0
                                 : ((d_pick < destroy_weights[0] + destroy_weights[1]) ? 1 : 2);

            const double r_sum = repair_weights[0] + repair_weights[1];
            const int r_op = (unit_dist(wstate.prng) * r_sum < repair_weights[0]) ? 0 : 1;

            AlnsSolution cand_sol = current_sol;
            destroy_solution(cand_sol, d_op, wstate.prng);
            repair_solution(cand_sol, r_op, wstate.prng);
            local_search_intensify(cand_sol);

            double op_reward = 0.2;
            const double cand_cost = cand_sol.objective_cost;

            // Simulated annealing acceptance
            const double delta = cand_cost - current_sol.objective_cost;
            if (delta < 0.0 ||
                std::exp(-delta / std::max(1e-3, temperature)) > unit_dist(wstate.prng)) {
                current_sol = cand_sol;
                op_reward = (delta < 0.0) ? 1.5 : 0.6;
            }

            // Atomic global upper-bound check & update (memory_order_acquire / release)
            double global_best = best_cost.load(std::memory_order_acquire);
            if (cand_cost + 1e-6 < global_best) {
                op_reward = 4.0;
                while (cand_cost + 1e-6 < global_best &&
                       !best_cost.compare_exchange_weak(
                           global_best, cand_cost,
                           std::memory_order_release,
                           std::memory_order_acquire)) {
                }
                std::lock_guard<std::mutex> lock(best_sol_mutex);
                if (cand_cost < best_sol.objective_cost) {
                    best_sol = std::move(cand_sol);
                }
            }

            // Adaptive weight update
            destroy_weights[static_cast<size_t>(d_op)] =
                0.85 * destroy_weights[static_cast<size_t>(d_op)] + 0.15 * op_reward;
            repair_weights[static_cast<size_t>(r_op)] =
                0.85 * repair_weights[static_cast<size_t>(r_op)] + 0.15 * op_reward;
            temperature *= kCoolingRate;
        }
    };

    if (pool_ != nullptr && num_trajectories > 1U) {
        std::vector<std::future<void>> futures;
        futures.reserve(num_trajectories);
        for (uint32_t t = 0; t < num_trajectories; ++t) {
            futures.push_back(pool_->submit(
                [&run_trajectory, t](uint32_t /*worker_id*/, std::stop_token worker_st) {
                    run_trajectory(t, std::move(worker_st));
                }));
        }
        for (auto& fut : futures) {
            fut.get();
        }
    } else if (num_trajectories > 1U) {
        std::vector<std::jthread> workers;
        workers.reserve(num_trajectories);
        for (uint32_t t = 0; t < num_trajectories; ++t) {
            workers.emplace_back([&run_trajectory, t](std::stop_token worker_st) {
                run_trajectory(t, std::move(worker_st));
            });
        }
    } else {
        run_trajectory(0U, stop_token);
    }

    const auto end_tp = std::chrono::steady_clock::now();
    best_sol.solver_duration_ms = std::max<int64_t>(
        0, std::chrono::duration_cast<std::chrono::milliseconds>(end_tp - start_tp).count());
    best_sol.iterations_completed = total_iterations.load(std::memory_order_relaxed);
    best_sol.deadline_exceeded = any_timeout.load(std::memory_order_acquire);

    best_sol.unassigned_stop_ids.clear();
    for (uint32_t u_idx : best_sol.unassigned_stop_indices) {
        best_sol.unassigned_stop_ids.push_back(stops[u_idx].stop_id);
    }

    bool all_routes_feasible = true;
    for (const auto& r : best_sol.routes) {
        if (!r.feasible) {
            all_routes_feasible = false;
            break;
        }
    }

    if (best_sol.deadline_exceeded) {
        best_sol.status = AlnsStatus::TimeoutBestEffort;
    } else if (!all_routes_feasible ||
               (!config.allow_unassigned_stops && !best_sol.unassigned_stop_indices.empty())) {
        best_sol.status = AlnsStatus::Infeasible;
    } else {
        best_sol.status = AlnsStatus::Feasible;
    }

    return best_sol;
}

} // namespace chronos
