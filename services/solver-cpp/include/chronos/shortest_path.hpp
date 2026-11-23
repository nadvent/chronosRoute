#pragma once

// ============================================================================
// [CO-AUTHORED] Module CPP-4: Contraction Hierarchies (CH), Landmark A* (ALT),
// & Generation-Stamped Thread-Local Scratchpad
// ============================================================================

#include "chronos/csr_graph.hpp"
#include "chronos/thread_pool.hpp"

#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <vector>

namespace chronos {

inline constexpr int64_t kUnreachableDurationMs = std::numeric_limits<int64_t>::max() / 4;

struct PathResult {
    int64_t duration_ms{kUnreachableDurationMs};
    int64_t distance_meters{0};
    uint32_t nodes_settled{0};
    bool reachable{false};
};

struct MatrixResult {
    int32_t rows{0};
    int32_t cols{0};
    std::vector<int64_t> durations_ms;     // Row-major R x C
    std::vector<int64_t> distances_meters; // Row-major R x C
};

// Pre-allocated per-thread scratchpad using generation stamps (vis_stamp[v] == query_id)
// to eliminate O(V) std::fill overhead between shortest-path queries and avoid
// mutable globals in multithreaded gRPC servers.
struct Scratchpad {
    uint32_t generation{1};
    std::vector<uint32_t> vis_stamp;
    std::vector<uint32_t> closed_stamp;
    std::vector<int64_t> dist_ms;
    std::vector<int64_t> dist_meters;
    std::vector<uint32_t> parent_node;
    std::vector<uint32_t> parent_edge;

    // Reverse search buffers for bidirectional Contraction Hierarchies (CH)
    std::vector<uint32_t> rev_vis_stamp;
    std::vector<uint32_t> rev_closed_stamp;
    std::vector<int64_t> rev_dist_ms;
    std::vector<int64_t> rev_dist_meters;

    void ensure_capacity(uint32_t num_nodes) {
        if (vis_stamp.size() < num_nodes) {
            vis_stamp.assign(num_nodes, 0U);
            closed_stamp.assign(num_nodes, 0U);
            dist_ms.assign(num_nodes, kUnreachableDurationMs);
            dist_meters.assign(num_nodes, 0);
            parent_node.assign(num_nodes, std::numeric_limits<uint32_t>::max());
            parent_edge.assign(num_nodes, std::numeric_limits<uint32_t>::max());
            rev_vis_stamp.assign(num_nodes, 0U);
            rev_closed_stamp.assign(num_nodes, 0U);
            rev_dist_ms.assign(num_nodes, kUnreachableDurationMs);
            rev_dist_meters.assign(num_nodes, 0);
        }
    }

    uint32_t next_generation(uint32_t num_nodes) {
        ensure_capacity(num_nodes);
        ++generation;
        if (generation == 0U) {
            std::fill(vis_stamp.begin(), vis_stamp.end(), 0U);
            std::fill(closed_stamp.begin(), closed_stamp.end(), 0U);
            std::fill(rev_vis_stamp.begin(), rev_vis_stamp.end(), 0U);
            std::fill(rev_closed_stamp.begin(), rev_closed_stamp.end(), 0U);
            generation = 1U;
        }
        return generation;
    }
};

class ShortestPathEngine {
public:
    explicit ShortestPathEngine(std::shared_ptr<const CsrGraph> graph,
                                uint32_t num_landmarks = 8);

    // Preprocess Landmark A* (ALT) potentials and Contraction Hierarchy (CH) shortcuts
    // for the given snapshot.
    void preprocess(const EdgeWeightSnapshot& snapshot);

    // Obtain the calling thread's thread_local Scratchpad sized for this graph
    [[nodiscard]] static Scratchpad& thread_local_scratchpad(uint32_t num_nodes);

    // 1. Baseline Dijkstra (exact reference oracle)
    [[nodiscard]] PathResult query_dijkstra(uint32_t source, uint32_t target,
                                            const EdgeWeightSnapshot& snapshot,
                                            Scratchpad& scratch) const;

    // 2. Landmark A* (ALT) using triangle-inequality lower bounds
    [[nodiscard]] PathResult query_alt(uint32_t source, uint32_t target,
                                       const EdgeWeightSnapshot& snapshot,
                                       Scratchpad& scratch) const;

    // 3. Bidirectional Contraction Hierarchies (CH) upward search
    [[nodiscard]] PathResult query_ch(uint32_t source, uint32_t target,
                                      const EdgeWeightSnapshot& snapshot,
                                      Scratchpad& scratch) const;

    // 4. Reconstruct full CSR road-graph node coordinate path from source -> target
    // using the caller's thread-local Scratchpad (zero mutable globals, TSan-clean).
    [[nodiscard]] std::vector<NodeCoord> reconstruct_path_coords(
        uint32_t source, uint32_t target,
        const EdgeWeightSnapshot& snapshot,
        Scratchpad& scratch) const;

    // Compute R x C asymmetric travel-time and distance matrix in < 15ms.
    // Dispatches rows across the work-stealing ThreadPool if provided.
    [[nodiscard]] MatrixResult compute_matrix(std::span<const uint32_t> origin_nodes,
                                              std::span<const uint32_t> dest_nodes,
                                              const EdgeWeightSnapshot& snapshot,
                                              ThreadPool* pool = nullptr) const;

    [[nodiscard]] MatrixResult compute_matrix_from_coords(
        std::span<const NodeCoord> origins,
        std::span<const NodeCoord> destinations,
        const EdgeWeightSnapshot& snapshot,
        ThreadPool* pool = nullptr) const;

    [[nodiscard]] uint32_t num_landmarks() const noexcept {
        return static_cast<uint32_t>(landmarks_.size());
    }

    [[nodiscard]] uint64_t preprocessed_version() const noexcept {
        return preprocessed_version_;
    }

private:
    struct ChShortcutEdge {
        uint32_t target{0};
        int64_t duration_ms{0};
        int64_t distance_meters{0};
    };

    [[nodiscard]] int64_t alt_heuristic(uint32_t u, uint32_t target,
                                        double inv_max_speed_scale) const noexcept;

    void build_landmarks(const EdgeWeightSnapshot& snapshot);
    void build_contraction_hierarchy(const EdgeWeightSnapshot& snapshot);

    std::shared_ptr<const CsrGraph> graph_;
    uint32_t requested_landmarks_{8};
    uint64_t preprocessed_version_{0};

    // ALT landmark tables: landmark_from_[k][v] = d(L_k, v), landmark_to_[k][v] = d(v, L_k)
    std::vector<uint32_t> landmarks_;
    std::vector<std::vector<int64_t>> landmark_from_;
    std::vector<std::vector<int64_t>> landmark_to_;

    // Contraction Hierarchies (CH) upward graphs
    std::vector<uint32_t> ch_rank_;
    std::vector<std::vector<ChShortcutEdge>> ch_up_forward_;
    std::vector<std::vector<ChShortcutEdge>> ch_up_backward_;
};

// Smooth sharp intersection turns along a coordinate path with quadratic Bezier fillets.
[[nodiscard]] std::vector<NodeCoord> smooth_path_corners(
    std::span<const NodeCoord> coords,
    double fillet_meters = 10.0,
    uint32_t arc_steps = 3U);

// Encode a sequence of WGS84 NodeCoord vertices using Google Encoded Polyline (precision 1e5).
[[nodiscard]] std::string encode_polyline5(std::span<const NodeCoord> coords);

} // namespace chronos
