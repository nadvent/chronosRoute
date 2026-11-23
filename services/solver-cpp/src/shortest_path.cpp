#include "chronos/shortest_path.hpp"

#include <algorithm>
#include <cmath>
#include <future>
#include <queue>
#include <tuple>
#include <unordered_map>

namespace chronos {

namespace {

struct PqItem {
    int64_t priority{0};
    int64_t duration_ms{0};
    int64_t distance_m{0};
    uint32_t node{0};

    bool operator>(const PqItem& other) const noexcept {
        if (priority != other.priority) return priority > other.priority;
        if (duration_ms != other.duration_ms) return duration_ms > other.duration_ms;
        if (distance_m != other.distance_m) return distance_m > other.distance_m;
        return node > other.node;
    }
};

} // namespace

ShortestPathEngine::ShortestPathEngine(std::shared_ptr<const CsrGraph> graph,
                                       uint32_t num_landmarks)
    : graph_(std::move(graph)),
      requested_landmarks_(std::max<uint32_t>(1U, num_landmarks)) {
    if (graph_ && graph_->num_nodes() > 0U) {
        auto snap = graph_->get_snapshot();
        if (snap) {
            preprocess(*snap);
        }
    }
}

Scratchpad& ShortestPathEngine::thread_local_scratchpad(uint32_t num_nodes) {
    thread_local Scratchpad tls_scratchpad{};
    tls_scratchpad.ensure_capacity(num_nodes);
    return tls_scratchpad;
}

void ShortestPathEngine::preprocess(const EdgeWeightSnapshot& snapshot) {
    if (!graph_ || graph_->num_nodes() == 0U) return;
    build_landmarks(snapshot);
    build_contraction_hierarchy(snapshot);
    preprocessed_version_ = snapshot.version;
}

void ShortestPathEngine::build_landmarks(const EdgeWeightSnapshot& snapshot) {
    const uint32_t n = graph_->num_nodes();
    const uint32_t k = std::min<uint32_t>(requested_landmarks_, n);
    landmarks_.clear();
    landmarks_.reserve(k);

    // Farthest-first / evenly spaced landmark selection across vertex IDs
    for (uint32_t i = 0; i < k; ++i) {
        const uint32_t lm = static_cast<uint32_t>(
            (static_cast<uint64_t>(i) * static_cast<uint64_t>(n)) / static_cast<uint64_t>(k));
        landmarks_.push_back(lm);
    }

    landmark_from_.assign(k, std::vector<int64_t>(n, kUnreachableDurationMs));
    landmark_to_.assign(k, std::vector<int64_t>(n, kUnreachableDurationMs));

    const auto& row_off = graph_->row_offsets();
    const auto& col_idx = graph_->col_indices();
    const auto& rev_row_off = graph_->rev_row_offsets();
    const auto& rev_col_idx = graph_->rev_col_indices();
    const auto& rev_edge_idx = graph_->rev_edge_indices();

    for (uint32_t idx = 0; idx < k; ++idx) {
        const uint32_t root = landmarks_[idx];

        // 1. Forward Dijkstra from landmark root -> all v
        {
            auto& dist = landmark_from_[idx];
            std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> pq;
            dist[root] = 0;
            pq.push(PqItem{0, 0, 0, root});

            while (!pq.empty()) {
                const PqItem cur = pq.top();
                pq.pop();
                if (cur.duration_ms > dist[cur.node]) continue;

                for (uint32_t e = row_off[cur.node];
                     e < row_off[static_cast<size_t>(cur.node) + 1U]; ++e) {
                    const uint32_t nxt = col_idx[e];
                    const int64_t w = graph_->effective_duration_ms(e, snapshot);
                    const int64_t cand = cur.duration_ms + w;
                    if (cand < dist[nxt]) {
                        dist[nxt] = cand;
                        pq.push(PqItem{cand, cand, 0, nxt});
                    }
                }
            }
        }

        // 2. Backward Dijkstra to landmark root <- all v
        {
            auto& dist = landmark_to_[idx];
            std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> pq;
            dist[root] = 0;
            pq.push(PqItem{0, 0, 0, root});

            while (!pq.empty()) {
                const PqItem cur = pq.top();
                pq.pop();
                if (cur.duration_ms > dist[cur.node]) continue;

                for (uint32_t re = rev_row_off[cur.node];
                     re < rev_row_off[static_cast<size_t>(cur.node) + 1U]; ++re) {
                    const uint32_t prev = rev_col_idx[re];
                    const uint32_t orig_e = rev_edge_idx[re];
                    const int64_t w = graph_->effective_duration_ms(orig_e, snapshot);
                    const int64_t cand = cur.duration_ms + w;
                    if (cand < dist[prev]) {
                        dist[prev] = cand;
                        pq.push(PqItem{cand, cand, 0, prev});
                    }
                }
            }
        }
    }
}

void ShortestPathEngine::build_contraction_hierarchy(const EdgeWeightSnapshot& snapshot) {
    const uint32_t n = graph_->num_nodes();
    ch_rank_.resize(n);
    ch_up_forward_.assign(n, {});
    ch_up_backward_.assign(n, {});

    // Order vertices by total degree (out_degree + in_degree) for sparser shortcuts
    std::vector<uint32_t> order(n);
    for (uint32_t u = 0; u < n; ++u) {
        order[u] = u;
    }
    std::sort(order.begin(), order.end(), [this](uint32_t a, uint32_t b) {
        const auto [af0, af1] = graph_->outgoing_edge_range(a);
        const auto [ab0, ab1] = graph_->incoming_edge_range(a);
        const auto [bf0, bf1] = graph_->outgoing_edge_range(b);
        const auto [bb0, bb1] = graph_->incoming_edge_range(b);
        const uint32_t deg_a = (af1 - af0) + (ab1 - ab0);
        const uint32_t deg_b = (bf1 - bf0) + (bb1 - bb0);
        if (deg_a != deg_b) return deg_a < deg_b;
        return a < b;
    });

    for (uint32_t r = 0; r < n; ++r) {
        ch_rank_[order[r]] = r;
    }

    // Dynamic working graph during contraction:
    // out_edges[u][v] = (duration_ms, distance_meters)
    std::vector<std::unordered_map<uint32_t, std::pair<int64_t, int64_t>>> out_edges(n);
    std::vector<std::unordered_map<uint32_t, std::pair<int64_t, int64_t>>> in_edges(n);

    const auto& row_off = graph_->row_offsets();
    const auto& col_idx = graph_->col_indices();
    const auto& base_edges = graph_->base_edges();

    auto insert_or_relax = [&](uint32_t u, uint32_t v, int64_t dur, int64_t dist) {
        if (u == v) return;
        auto& out_map = out_edges[u];
        auto it = out_map.find(v);
        if (it == out_map.end() ||
            std::tie(dur, dist) < std::tie(it->second.first, it->second.second)) {
            out_map[v] = {dur, dist};
            in_edges[v][u] = {dur, dist};
        }
    };

    for (uint32_t u = 0; u < n; ++u) {
        for (uint32_t e = row_off[u]; e < row_off[static_cast<size_t>(u) + 1U]; ++e) {
            const uint32_t v = col_idx[e];
            const int64_t dur = graph_->effective_duration_ms(e, snapshot);
            const int64_t dist = base_edges[e].distance_meters;
            insert_or_relax(u, v, dur, dist);
        }
    }

    // Contract vertices in increasing rank order
    for (uint32_t r = 0; r < n; ++r) {
        const uint32_t v = order[r];

        // Collect active higher-rank incoming and outgoing neighbors
        std::vector<std::pair<uint32_t, std::pair<int64_t, int64_t>>> higher_in;
        std::vector<std::pair<uint32_t, std::pair<int64_t, int64_t>>> higher_out;

        for (const auto& [u, w_pair] : in_edges[v]) {
            if (ch_rank_[u] > r) {
                higher_in.push_back({u, w_pair});
                ch_up_backward_[v].push_back(ChShortcutEdge{u, w_pair.first, w_pair.second});
            }
        }
        for (const auto& [w, w_pair] : out_edges[v]) {
            if (ch_rank_[w] > r) {
                higher_out.push_back({w, w_pair});
                ch_up_forward_[v].push_back(ChShortcutEdge{w, w_pair.first, w_pair.second});
            }
        }

        // Add shortcuts between higher_in (u) and higher_out (w)
        for (const auto& [u, uv] : higher_in) {
            for (const auto& [w, vw] : higher_out) {
                if (u == w) continue;
                const int64_t sc_dur = uv.first + vw.first;
                const int64_t sc_dist = uv.second + vw.second;

                // Local 2-hop witness check through remaining uncontracted vertices
                bool witnessed_strictly_better = false;
                auto direct_it = out_edges[u].find(w);
                if (direct_it != out_edges[u].end() &&
                    std::tie(direct_it->second.first, direct_it->second.second) <=
                        std::tie(sc_dur, sc_dist)) {
                    witnessed_strictly_better = true;
                }

                if (!witnessed_strictly_better) {
                    insert_or_relax(u, w, sc_dur, sc_dist);
                }
            }
        }
    }
}

int64_t ShortestPathEngine::alt_heuristic(uint32_t u, uint32_t target,
                                          double inv_max_speed_scale) const noexcept {
    if (u == target || landmarks_.empty()) return 0;
    int64_t best_lb = 0;
    const size_t num_lm = landmarks_.size();

    for (size_t k = 0; k < num_lm; ++k) {
        const int64_t d_lm_u = landmark_from_[k][u];
        const int64_t d_lm_t = landmark_from_[k][target];
        if (d_lm_u < kUnreachableDurationMs && d_lm_t < kUnreachableDurationMs &&
            d_lm_t > d_lm_u) {
            best_lb = std::max(best_lb, d_lm_t - d_lm_u);
        }

        const int64_t d_u_lm = landmark_to_[k][u];
        const int64_t d_t_lm = landmark_to_[k][target];
        if (d_u_lm < kUnreachableDurationMs && d_t_lm < kUnreachableDurationMs &&
            d_u_lm > d_t_lm) {
            best_lb = std::max(best_lb, d_u_lm - d_t_lm);
        }
    }

    if (inv_max_speed_scale < 0.999999) {
        best_lb = static_cast<int64_t>(std::floor(static_cast<double>(best_lb) * inv_max_speed_scale));
    }
    return std::max<int64_t>(0, best_lb);
}

PathResult ShortestPathEngine::query_dijkstra(uint32_t source, uint32_t target,
                                              const EdgeWeightSnapshot& snapshot,
                                              Scratchpad& scratch) const {
    if (!graph_ || source >= graph_->num_nodes() || target >= graph_->num_nodes()) {
        return PathResult{};
    }
    if (source == target) {
        return PathResult{0, 0, 1U, true};
    }

    const uint32_t n = graph_->num_nodes();
    const uint32_t gen = scratch.next_generation(n);

    const auto& row_off = graph_->row_offsets();
    const auto& col_idx = graph_->col_indices();
    const auto& base_edges = graph_->base_edges();

    std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> pq;
    scratch.vis_stamp[source] = gen;
    scratch.dist_ms[source] = 0;
    scratch.dist_meters[source] = 0;
    pq.push(PqItem{0, 0, 0, source});

    uint32_t settled = 0;
    while (!pq.empty()) {
        const PqItem cur = pq.top();
        pq.pop();

        if (scratch.closed_stamp[cur.node] == gen) {
            continue;
        }
        scratch.closed_stamp[cur.node] = gen;
        ++settled;

        if (cur.node == target) {
            return PathResult{cur.duration_ms, cur.distance_m, settled, true};
        }

        for (uint32_t e = row_off[cur.node];
             e < row_off[static_cast<size_t>(cur.node) + 1U]; ++e) {
            const uint32_t nxt = col_idx[e];
            if (scratch.closed_stamp[nxt] == gen) continue;

            const int64_t w_ms = graph_->effective_duration_ms(e, snapshot);
            const int64_t w_m = base_edges[e].distance_meters;
            const int64_t cand_dur = cur.duration_ms + w_ms;
            const int64_t cand_dist = cur.distance_m + w_m;

            const bool unvisited = (scratch.vis_stamp[nxt] != gen);
            if (unvisited ||
                std::tie(cand_dur, cand_dist) <
                    std::tie(scratch.dist_ms[nxt], scratch.dist_meters[nxt])) {
                scratch.vis_stamp[nxt] = gen;
                scratch.dist_ms[nxt] = cand_dur;
                scratch.dist_meters[nxt] = cand_dist;
                pq.push(PqItem{cand_dur, cand_dur, cand_dist, nxt});
            }
        }
    }

    return PathResult{kUnreachableDurationMs, 0, settled, false};
}

PathResult ShortestPathEngine::query_alt(uint32_t source, uint32_t target,
                                         const EdgeWeightSnapshot& snapshot,
                                         Scratchpad& scratch) const {
    if (!graph_ || source >= graph_->num_nodes() || target >= graph_->num_nodes()) {
        return PathResult{};
    }
    if (source == target) {
        return PathResult{0, 0, 1U, true};
    }

    const uint32_t n = graph_->num_nodes();
    const uint32_t gen = scratch.next_generation(n);

    // Ensure heuristic stays strictly admissible & consistent if speed multipliers > 1.0
    double inv_max_speed_scale = 1.0;
    if (snapshot.version != preprocessed_version_) {
        float max_mult = 1.0f;
        for (float m : snapshot.speed_multipliers) {
            if (m > max_mult) max_mult = m;
        }
        inv_max_speed_scale = 1.0 / static_cast<double>(std::clamp(max_mult, 1.0f, 10.0f));
    }

    const auto& row_off = graph_->row_offsets();
    const auto& col_idx = graph_->col_indices();
    const auto& base_edges = graph_->base_edges();

    std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> pq;
    scratch.vis_stamp[source] = gen;
    scratch.dist_ms[source] = 0;
    scratch.dist_meters[source] = 0;
    const int64_t h0 = alt_heuristic(source, target, inv_max_speed_scale);
    pq.push(PqItem{h0, 0, 0, source});

    uint32_t settled = 0;
    while (!pq.empty()) {
        const PqItem cur = pq.top();
        pq.pop();

        if (scratch.closed_stamp[cur.node] == gen) {
            continue;
        }
        scratch.closed_stamp[cur.node] = gen;
        ++settled;

        if (cur.node == target) {
            return PathResult{cur.duration_ms, cur.distance_m, settled, true};
        }

        for (uint32_t e = row_off[cur.node];
             e < row_off[static_cast<size_t>(cur.node) + 1U]; ++e) {
            const uint32_t nxt = col_idx[e];
            if (scratch.closed_stamp[nxt] == gen) continue;

            const int64_t w_ms = graph_->effective_duration_ms(e, snapshot);
            const int64_t w_m = base_edges[e].distance_meters;
            const int64_t cand_dur = cur.duration_ms + w_ms;
            const int64_t cand_dist = cur.distance_m + w_m;

            const bool unvisited = (scratch.vis_stamp[nxt] != gen);
            if (unvisited ||
                std::tie(cand_dur, cand_dist) <
                    std::tie(scratch.dist_ms[nxt], scratch.dist_meters[nxt])) {
                scratch.vis_stamp[nxt] = gen;
                scratch.dist_ms[nxt] = cand_dur;
                scratch.dist_meters[nxt] = cand_dist;
                const int64_t h = alt_heuristic(nxt, target, inv_max_speed_scale);
                pq.push(PqItem{cand_dur + h, cand_dur, cand_dist, nxt});
            }
        }
    }

    return PathResult{kUnreachableDurationMs, 0, settled, false};
}

PathResult ShortestPathEngine::query_ch(uint32_t source, uint32_t target,
                                        const EdgeWeightSnapshot& snapshot,
                                        Scratchpad& scratch) const {
    if (!graph_ || source >= graph_->num_nodes() || target >= graph_->num_nodes()) {
        return PathResult{};
    }
    if (source == target) {
        return PathResult{0, 0, 1U, true};
    }

    // If dynamic traffic weights updated since CH preprocessing, delegate to ALT
    // which maintains admissible potentials without rebuilding shortcuts
    if (snapshot.version != preprocessed_version_ || ch_up_forward_.empty()) {
        return query_alt(source, target, snapshot, scratch);
    }

    const uint32_t n = graph_->num_nodes();
    const uint32_t gen = scratch.next_generation(n);

    std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> fwd_pq;
    std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> bwd_pq;

    scratch.vis_stamp[source] = gen;
    scratch.dist_ms[source] = 0;
    scratch.dist_meters[source] = 0;
    fwd_pq.push(PqItem{0, 0, 0, source});

    scratch.rev_vis_stamp[target] = gen;
    scratch.rev_dist_ms[target] = 0;
    scratch.rev_dist_meters[target] = 0;
    bwd_pq.push(PqItem{0, 0, 0, target});

    int64_t best_dur = kUnreachableDurationMs;
    int64_t best_dist = std::numeric_limits<int64_t>::max();
    uint32_t settled = 0;

    while (!fwd_pq.empty() || !bwd_pq.empty()) {
        const int64_t min_fwd = fwd_pq.empty() ? kUnreachableDurationMs : fwd_pq.top().duration_ms;
        const int64_t min_bwd = bwd_pq.empty() ? kUnreachableDurationMs : bwd_pq.top().duration_ms;
        if (min_fwd > best_dur && min_bwd > best_dur) {
            break;
        }

        if (!fwd_pq.empty() && min_fwd <= min_bwd) {
            const PqItem cur = fwd_pq.top();
            fwd_pq.pop();

            if (scratch.closed_stamp[cur.node] != gen) {
                scratch.closed_stamp[cur.node] = gen;
                ++settled;

                if (scratch.rev_vis_stamp[cur.node] == gen) {
                    const int64_t total_dur = cur.duration_ms + scratch.rev_dist_ms[cur.node];
                    const int64_t total_dist = cur.distance_m + scratch.rev_dist_meters[cur.node];
                    if (std::tie(total_dur, total_dist) < std::tie(best_dur, best_dist)) {
                        best_dur = total_dur;
                        best_dist = total_dist;
                    }
                }

                if (cur.duration_ms <= best_dur) {
                    for (const auto& sc : ch_up_forward_[cur.node]) {
                        const int64_t cand_dur = cur.duration_ms + sc.duration_ms;
                        const int64_t cand_dist = cur.distance_m + sc.distance_meters;
                        if (scratch.vis_stamp[sc.target] != gen ||
                            std::tie(cand_dur, cand_dist) <
                                std::tie(scratch.dist_ms[sc.target],
                                         scratch.dist_meters[sc.target])) {
                            scratch.vis_stamp[sc.target] = gen;
                            scratch.dist_ms[sc.target] = cand_dur;
                            scratch.dist_meters[sc.target] = cand_dist;
                            fwd_pq.push(PqItem{cand_dur, cand_dur, cand_dist, sc.target});
                        }
                    }
                }
            }
        }

        if (!bwd_pq.empty() && min_bwd <= min_fwd) {
            const PqItem cur = bwd_pq.top();
            bwd_pq.pop();

            if (scratch.rev_closed_stamp[cur.node] != gen) {
                scratch.rev_closed_stamp[cur.node] = gen;
                ++settled;

                if (scratch.vis_stamp[cur.node] == gen) {
                    const int64_t total_dur = scratch.dist_ms[cur.node] + cur.duration_ms;
                    const int64_t total_dist = scratch.dist_meters[cur.node] + cur.distance_m;
                    if (std::tie(total_dur, total_dist) < std::tie(best_dur, best_dist)) {
                        best_dur = total_dur;
                        best_dist = total_dist;
                    }
                }

                if (cur.duration_ms <= best_dur) {
                    for (const auto& sc : ch_up_backward_[cur.node]) {
                        const int64_t cand_dur = cur.duration_ms + sc.duration_ms;
                        const int64_t cand_dist = cur.distance_m + sc.distance_meters;
                        if (scratch.rev_vis_stamp[sc.target] != gen ||
                            std::tie(cand_dur, cand_dist) <
                                std::tie(scratch.rev_dist_ms[sc.target],
                                         scratch.rev_dist_meters[sc.target])) {
                            scratch.rev_vis_stamp[sc.target] = gen;
                            scratch.rev_dist_ms[sc.target] = cand_dur;
                            scratch.rev_dist_meters[sc.target] = cand_dist;
                            bwd_pq.push(PqItem{cand_dur, cand_dur, cand_dist, sc.target});
                        }
                    }
                }
            }
        }
    }

    if (best_dur >= kUnreachableDurationMs) {
        return PathResult{kUnreachableDurationMs, 0, settled, false};
    }
    return PathResult{best_dur, best_dist, settled, true};
}

MatrixResult ShortestPathEngine::compute_matrix(std::span<const uint32_t> origin_nodes,
                                                std::span<const uint32_t> dest_nodes,
                                                const EdgeWeightSnapshot& snapshot,
                                                ThreadPool* pool) const {
    MatrixResult result;
    result.rows = static_cast<int32_t>(origin_nodes.size());
    result.cols = static_cast<int32_t>(dest_nodes.size());
    const size_t total = origin_nodes.size() * dest_nodes.size();
    result.durations_ms.assign(total, kUnreachableDurationMs);
    result.distances_meters.assign(total, 0);

    if (!graph_ || origin_nodes.empty() || dest_nodes.empty()) {
        return result;
    }

    const uint32_t n = graph_->num_nodes();

    auto compute_row = [&](size_t r) {
        Scratchpad& scratch = thread_local_scratchpad(n);
        const uint32_t src = origin_nodes[r];
        for (size_t c = 0; c < dest_nodes.size(); ++c) {
            const uint32_t dst = dest_nodes[c];
            const size_t idx = r * dest_nodes.size() + c;
            if (src == dst) {
                result.durations_ms[idx] = 0;
                result.distances_meters[idx] = 0;
            } else {
                const PathResult pr = query_ch(src, dst, snapshot, scratch);
                result.durations_ms[idx] = pr.duration_ms;
                result.distances_meters[idx] = pr.distance_meters;
            }
        }
    };

    if (pool != nullptr && origin_nodes.size() > 1U) {
        std::vector<std::future<void>> futures;
        futures.reserve(origin_nodes.size());
        for (size_t r = 0; r < origin_nodes.size(); ++r) {
            futures.push_back(pool->submit(
                [&compute_row, r](uint32_t /*worker_id*/, std::stop_token /*st*/) {
                    compute_row(r);
                }));
        }
        for (auto& fut : futures) {
            fut.get();
        }
    } else {
        for (size_t r = 0; r < origin_nodes.size(); ++r) {
            compute_row(r);
        }
    }

    return result;
}

MatrixResult ShortestPathEngine::compute_matrix_from_coords(
    std::span<const NodeCoord> origins,
    std::span<const NodeCoord> destinations,
    const EdgeWeightSnapshot& snapshot,
    ThreadPool* pool) const {
    std::vector<uint32_t> origin_nodes(origins.size(), 0U);
    std::vector<uint32_t> dest_nodes(destinations.size(), 0U);
    if (graph_) {
        for (size_t i = 0; i < origins.size(); ++i) {
            origin_nodes[i] = graph_->find_nearest_node(origins[i]);
        }
        for (size_t j = 0; j < destinations.size(); ++j) {
            dest_nodes[j] = graph_->find_nearest_node(destinations[j]);
        }
    }
    return compute_matrix(origin_nodes, dest_nodes, snapshot, pool);
}

std::vector<NodeCoord> ShortestPathEngine::reconstruct_path_coords(
    uint32_t source, uint32_t target,
    const EdgeWeightSnapshot& snapshot,
    Scratchpad& scratch) const {
    if (!graph_ || graph_->num_nodes() == 0U) {
        return {};
    }
    const uint32_t n = graph_->num_nodes();
    if (source >= n || target >= n) {
        return {};
    }
    const auto& coords = graph_->node_coords();
    if (source == target) {
        return {coords[source]};
    }

    const uint32_t gen = scratch.next_generation(n);
    constexpr uint32_t kNoParent = std::numeric_limits<uint32_t>::max();
    const auto& row_off = graph_->row_offsets();
    const auto& col_idx = graph_->col_indices();
    const auto& base_edges = graph_->base_edges();

    std::priority_queue<PqItem, std::vector<PqItem>, std::greater<PqItem>> pq;
    scratch.vis_stamp[source] = gen;
    scratch.dist_ms[source] = 0;
    scratch.dist_meters[source] = 0;
    scratch.parent_node[source] = kNoParent;
    scratch.parent_edge[source] = kNoParent;
    pq.push(PqItem{0, 0, 0, source});

    bool found = false;
    while (!pq.empty()) {
        const PqItem cur = pq.top();
        pq.pop();

        if (scratch.closed_stamp[cur.node] == gen) continue;
        scratch.closed_stamp[cur.node] = gen;

        if (cur.node == target) {
            found = true;
            break;
        }

        for (uint32_t e = row_off[cur.node];
             e < row_off[static_cast<size_t>(cur.node) + 1U]; ++e) {
            const uint32_t nxt = col_idx[e];
            if (scratch.closed_stamp[nxt] == gen) continue;

            const int64_t cand_dur = cur.duration_ms + graph_->effective_duration_ms(e, snapshot);
            const int64_t cand_dist = cur.distance_m + base_edges[e].distance_meters;

            if (scratch.vis_stamp[nxt] != gen ||
                std::tie(cand_dur, cand_dist) <
                    std::tie(scratch.dist_ms[nxt], scratch.dist_meters[nxt])) {
                scratch.vis_stamp[nxt] = gen;
                scratch.dist_ms[nxt] = cand_dur;
                scratch.dist_meters[nxt] = cand_dist;
                scratch.parent_node[nxt] = cur.node;
                scratch.parent_edge[nxt] = e;
                pq.push(PqItem{cand_dur, cand_dur, cand_dist, nxt});
            }
        }
    }

    if (!found) {
        return {coords[source], coords[target]};
    }

    // Backtrack traversed edges and emit full curved per-edge geometry (`edge_shape`)
    std::vector<std::pair<uint32_t, uint32_t>> rev_steps; // (from_node, edge_index)
    uint32_t cur = target;
    uint32_t guard = 0U;
    while (cur != source && cur != kNoParent && guard <= n) {
        const uint32_t p_node = scratch.parent_node[cur];
        const uint32_t p_edge = scratch.parent_edge[cur];
        if (p_node == kNoParent) break;
        rev_steps.push_back({p_node, p_edge});
        cur = p_node;
        ++guard;
    }
    std::reverse(rev_steps.begin(), rev_steps.end());

    std::vector<NodeCoord> raw_path;
    raw_path.push_back(coords[source]);
    for (const auto& [u, edge_idx] : rev_steps) {
        const auto shape = graph_->edge_shape(edge_idx);
        if (shape.size() >= 2U) {
            for (size_t k = 1U; k < shape.size(); ++k) {
                raw_path.push_back(shape[k]);
            }
        } else if (edge_idx < graph_->num_edges()) {
            const uint32_t v = col_idx[edge_idx];
            raw_path.push_back(coords[v]);
        }
        (void)u;
    }

    return raw_path;
}

std::vector<NodeCoord> smooth_path_corners(
    std::span<const NodeCoord> coords,
    double fillet_meters,
    uint32_t arc_steps) {
    if (coords.size() <= 2U || fillet_meters <= 0.5) {
        return std::vector<NodeCoord>(coords.begin(), coords.end());
    }

    const uint32_t steps = std::clamp<uint32_t>(arc_steps, 2U, 6U);
    constexpr double kDegToRad = 3.14159265358979323846 / 180.0;
    constexpr double kRadToDeg = 180.0 / 3.14159265358979323846;

    auto bearing_deg = [](NodeCoord a, NodeCoord b) noexcept -> double {
        const double phi1 = a.latitude * kDegToRad;
        const double phi2 = b.latitude * kDegToRad;
        const double dlon = (b.longitude - a.longitude) * kDegToRad;
        const double y = std::sin(dlon) * std::cos(phi2);
        const double x =
            std::cos(phi1) * std::sin(phi2) - std::sin(phi1) * std::cos(phi2) * std::cos(dlon);
        const double brng = std::atan2(y, x) * kRadToDeg;
        return std::fmod(brng + 360.0, 360.0);
    };

    std::vector<NodeCoord> out;
    out.reserve(coords.size() * 2U);
    out.push_back(coords.front());

    for (size_t i = 1U; i + 1U < coords.size(); ++i) {
        const NodeCoord a = coords[i - 1U];
        const NodeCoord b = coords[i];
        const NodeCoord c = coords[i + 1U];

        const double len1 = CsrGraph::haversine_meters(a, b);
        const double len2 = CsrGraph::haversine_meters(b, c);
        if (len1 < 6.0 || len2 < 6.0) {
            out.push_back(b);
            continue;
        }

        double turn = std::abs(bearing_deg(b, c) - bearing_deg(a, b));
        if (turn > 180.0) turn = 360.0 - turn;
        if (turn < 20.0 || turn > 165.0) {
            out.push_back(b);
            continue;
        }

        const double r = std::min({fillet_meters, len1 * 0.30, len2 * 0.30});
        const double f1 = r / len1;
        const double f2 = r / len2;
        const NodeCoord p0{
            b.latitude + (a.latitude - b.latitude) * f1,
            b.longitude + (a.longitude - b.longitude) * f1,
        };
        const NodeCoord p2{
            b.latitude + (c.latitude - b.latitude) * f2,
            b.longitude + (c.longitude - b.longitude) * f2,
        };

        for (uint32_t k = 0U; k <= steps; ++k) {
            const double t = static_cast<double>(k) / static_cast<double>(steps);
            const double u = 1.0 - t;
            out.push_back(NodeCoord{
                u * u * p0.latitude + 2.0 * u * t * b.latitude + t * t * p2.latitude,
                u * u * p0.longitude + 2.0 * u * t * b.longitude + t * t * p2.longitude,
            });
        }
    }

    out.push_back(coords.back());
    return out;
}

std::string encode_polyline5(std::span<const NodeCoord> coords) {
    if (coords.empty()) {
        return {};
    }
    std::string out;
    out.reserve(coords.size() * 8U);

    auto encode_signed = [&out](int64_t value) {
        uint64_t sgn = static_cast<uint64_t>(value < 0 ? ~(value << 1) : (value << 1));
        while (sgn >= 0x20U) {
            out.push_back(static_cast<char>((0x20U | (sgn & 0x1fU)) + 63U));
            sgn >>= 5U;
        }
        out.push_back(static_cast<char>(sgn + 63U));
    };

    int64_t prev_lat = 0;
    int64_t prev_lon = 0;
    for (const auto& pt : coords) {
        const int64_t lat_e5 = static_cast<int64_t>(std::llround(pt.latitude * 1e5));
        const int64_t lon_e5 = static_cast<int64_t>(std::llround(pt.longitude * 1e5));
        encode_signed(lat_e5 - prev_lat);
        encode_signed(lon_e5 - prev_lon);
        prev_lat = lat_e5;
        prev_lon = lon_e5;
    }
    return out;
}

} // namespace chronos
