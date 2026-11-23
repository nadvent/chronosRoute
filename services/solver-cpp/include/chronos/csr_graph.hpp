#pragma once

// ============================================================================
// [CO-AUTHORED] Module CPP-1 & CPP-2: Cache-Local CSR Road Graph &
// Lock-Free Atomic Double Buffering (ADR 0003)
// ============================================================================

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <span>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chronos {

struct NodeCoord {
    double latitude{0.0};
    double longitude{0.0};
};

struct RawEdge {
    uint32_t source{0};
    uint32_t target{0};
    int64_t edge_id{0};
    int64_t base_duration_ms{1000};
    int64_t distance_meters{100};
    uint8_t road_class{1};
    // Optional ordered curved road geometry from source -> target (empty => straight chord)
    std::vector<NodeCoord> shape_points{};
};

struct EdgeBase {
    int64_t edge_id{0};
    int64_t base_duration_ms{1000};
    int64_t distance_meters{100};
    uint8_t road_class{1};
};

struct EdgeMultiplierUpdate {
    int64_t edge_id{0};
    float speed_multiplier{1.0f};
};

// Immutable copy-on-write snapshot of dynamic speed multipliers.
// Shared across ALNS and shortest-path worker threads via wait-free atomic load.
struct EdgeWeightSnapshot {
    uint64_t version{1};
    int64_t timestamp_unix{0};
    std::vector<float> speed_multipliers;
};

class CsrGraph {
public:
    CsrGraph() = default;
    CsrGraph(uint32_t num_nodes, const std::vector<RawEdge>& edges,
             std::vector<NodeCoord> node_coords = {});

    CsrGraph(const CsrGraph&) = delete;
    CsrGraph& operator=(const CsrGraph&) = delete;
    CsrGraph(CsrGraph&&) = delete;
    CsrGraph& operator=(CsrGraph&&) = delete;

    [[nodiscard]] uint32_t num_nodes() const noexcept { return num_nodes_; }
    [[nodiscard]] uint32_t num_edges() const noexcept { return num_edges_; }

    // Contiguous CSR arrays for L1/L2 hardware prefetching
    [[nodiscard]] const std::vector<uint32_t>& row_offsets() const noexcept { return row_offsets_; }
    [[nodiscard]] const std::vector<uint32_t>& col_indices() const noexcept { return col_indices_; }
    [[nodiscard]] const std::vector<EdgeBase>& base_edges() const noexcept { return base_edges_; }
    [[nodiscard]] const std::vector<NodeCoord>& node_coords() const noexcept { return node_coords_; }

    // Cache-local contiguous curved road geometry span for directed edge `edge_index`
    [[nodiscard]] std::span<const NodeCoord> edge_shape(uint32_t edge_index) const noexcept {
        if (edge_index >= num_edges_ ||
            static_cast<size_t>(edge_index) + 1U >= edge_shape_offsets_.size()) {
            return {};
        }
        const uint32_t begin = edge_shape_offsets_[edge_index];
        const uint32_t end = edge_shape_offsets_[static_cast<size_t>(edge_index) + 1U];
        if (end <= begin || end > edge_shape_points_.size()) return {};
        return std::span<const NodeCoord>(edge_shape_points_.data() + begin, end - begin);
    }

    // Reverse CSR arrays for backward Dijkstra / CH / ALT landmark search
    [[nodiscard]] const std::vector<uint32_t>& rev_row_offsets() const noexcept { return rev_row_offsets_; }
    [[nodiscard]] const std::vector<uint32_t>& rev_col_indices() const noexcept { return rev_col_indices_; }
    [[nodiscard]] const std::vector<uint32_t>& rev_edge_indices() const noexcept { return rev_edge_indices_; }

    // O(1) outgoing degree and edge range lookup for vertex u
    [[nodiscard]] uint32_t out_degree(uint32_t u) const noexcept {
        if (u >= num_nodes_) return 0;
        return row_offsets_[u + 1] - row_offsets_[u];
    }

    [[nodiscard]] std::pair<uint32_t, uint32_t> outgoing_edge_range(uint32_t u) const noexcept {
        if (u >= num_nodes_) return {0U, 0U};
        return {row_offsets_[u], row_offsets_[u + 1]};
    }

    [[nodiscard]] std::pair<uint32_t, uint32_t> incoming_edge_range(uint32_t v) const noexcept {
        if (v >= num_nodes_) return {0U, 0U};
        return {rev_row_offsets_[v], rev_row_offsets_[v + 1]};
    }

    // Lock-free atomic double-buffering (ADR 0003):
    // Readers acquire a const snapshot pointer with memory_order_acquire.
    [[nodiscard]] std::shared_ptr<const EdgeWeightSnapshot> get_snapshot() const noexcept {
        return active_snapshot_.load(std::memory_order_acquire);
    }

    // Copy-on-write batch update of dynamic speed multipliers.
    // Clones the current snapshot, applies updates, and publishes with memory_order_release.
    // Returns the number of valid edges updated.
    uint32_t update_speed_multipliers(std::span<const EdgeMultiplierUpdate> updates,
                                      int64_t timestamp_unix = 0);

    // Replace all multipliers from a flat batch (e.g. from ONNX scorer inference output)
    uint32_t replace_all_speed_multipliers(std::span<const float> multipliers,
                                           int64_t timestamp_unix = 0);

    // Compute effective edge duration in milliseconds using a pre-loaded snapshot
    [[nodiscard]] int64_t effective_duration_ms(uint32_t edge_index,
                                                const EdgeWeightSnapshot& snapshot) const noexcept {
        if (edge_index >= num_edges_) return 0;
        const float raw_mult = (edge_index < snapshot.speed_multipliers.size())
                                   ? snapshot.speed_multipliers[edge_index]
                                   : 1.0f;
        const float clamped = std::clamp(raw_mult, 0.05f, 10.0f);
        const double scaled =
            static_cast<double>(base_edges_[edge_index].base_duration_ms) / static_cast<double>(clamped);
        return std::max<int64_t>(1, static_cast<int64_t>(std::llround(scaled)));
    }

    [[nodiscard]] float get_speed_multiplier(uint32_t edge_index,
                                             const EdgeWeightSnapshot& snapshot) const noexcept {
        if (edge_index >= snapshot.speed_multipliers.size()) return 1.0f;
        return snapshot.speed_multipliers[edge_index];
    }

    // Baseline comparison methods using std::shared_mutex (ADR 0003 benchmark baseline)
    [[nodiscard]] int64_t effective_duration_ms_shared_lock(uint32_t edge_index) const;
    uint32_t update_speed_multipliers_shared_lock(std::span<const EdgeMultiplierUpdate> updates);

    // Spatial helper: snap a coordinate to the nearest road graph node
    [[nodiscard]] uint32_t find_nearest_node(NodeCoord coord) const noexcept;

    // Haversine distance in meters between two coordinates
    [[nodiscard]] static double haversine_meters(NodeCoord a, NodeCoord b) noexcept;

    // Factory for a strongly-connected synthetic metropolitan grid road network
    [[nodiscard]] static std::shared_ptr<CsrGraph> create_synthetic_grid(
        uint32_t rows = 12, uint32_t cols = 12,
        double origin_lat = 37.7749, double origin_lon = -122.4194,
        double step_deg = 0.005);

    // Factory for a symmetrically centered curved radial-ring + organic arterial road network
    // where every directed edge stores multi-point curved road geometry (`edge_shape`).
    [[nodiscard]] static std::shared_ptr<CsrGraph> create_curved_urban_network(
        double center_lat = 51.5074, double center_lon = -0.1278,
        uint32_t rings = 4, uint32_t spokes = 12,
        double outer_radius_m = 4800.0);

    // Optional zero-dependency loader for compact `/api/v1/graph/network` JSON road dumps.
    [[nodiscard]] static std::shared_ptr<CsrGraph> load_from_json_file(const std::string& path);

private:
    uint32_t num_nodes_{0};
    uint32_t num_edges_{0};

    std::vector<uint32_t> row_offsets_;
    std::vector<uint32_t> col_indices_;
    std::vector<EdgeBase> base_edges_;
    std::vector<NodeCoord> node_coords_;
    std::vector<uint32_t> edge_shape_offsets_;
    std::vector<NodeCoord> edge_shape_points_;

    std::vector<uint32_t> rev_row_offsets_;
    std::vector<uint32_t> rev_col_indices_;
    std::vector<uint32_t> rev_edge_indices_;

    std::unordered_map<int64_t, uint32_t> edge_id_to_index_;

    // Lock-free atomic double buffer for wait-free reader threads
    std::atomic<std::shared_ptr<const EdgeWeightSnapshot>> active_snapshot_{nullptr};
    mutable std::mutex writer_mutex_;

    // Baseline comparison RW-lock state (ADR 0003)
    mutable std::shared_mutex rw_mutex_;
    std::vector<float> locked_multipliers_;
};

} // namespace chronos
