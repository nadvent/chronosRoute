#include "chronos/csr_graph.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <numbers>
#include <sstream>

namespace chronos {

CsrGraph::CsrGraph(uint32_t num_nodes, const std::vector<RawEdge>& edges,
                   std::vector<NodeCoord> node_coords)
    : num_nodes_(num_nodes),
      node_coords_(std::move(node_coords)) {
    if (node_coords_.size() < num_nodes_) {
        node_coords_.resize(num_nodes_, NodeCoord{0.0, 0.0});
    }

    // Filter valid edges with endpoints in [0, num_nodes_)
    std::vector<RawEdge> sorted_edges;
    sorted_edges.reserve(edges.size());
    for (const auto& edge : edges) {
        if (edge.source < num_nodes_ && edge.target < num_nodes_) {
            sorted_edges.push_back(edge);
        }
    }

    std::sort(sorted_edges.begin(), sorted_edges.end(),
              [](const RawEdge& a, const RawEdge& b) {
                  if (a.source != b.source) return a.source < b.source;
                  if (a.target != b.target) return a.target < b.target;
                  return a.edge_id < b.edge_id;
              });

    num_edges_ = static_cast<uint32_t>(sorted_edges.size());
    row_offsets_.assign(static_cast<size_t>(num_nodes_) + 1U, 0U);
    col_indices_.resize(num_edges_);
    base_edges_.resize(num_edges_);
    edge_shape_offsets_.assign(static_cast<size_t>(num_edges_) + 1U, 0U);
    edge_shape_points_.clear();

    for (uint32_t e = 0; e < num_edges_; ++e) {
        const auto& raw = sorted_edges[e];
        ++row_offsets_[static_cast<size_t>(raw.source) + 1U];
        col_indices_[e] = raw.target;
        base_edges_[e] = EdgeBase{
            raw.edge_id,
            std::max<int64_t>(1, raw.base_duration_ms),
            std::max<int64_t>(1, raw.distance_meters),
            raw.road_class,
        };
        edge_id_to_index_[raw.edge_id] = e;
        edge_shape_offsets_[e] = static_cast<uint32_t>(edge_shape_points_.size());
        if (raw.shape_points.size() >= 2U) {
            edge_shape_points_.insert(
                edge_shape_points_.end(), raw.shape_points.begin(), raw.shape_points.end());
        }
    }
    edge_shape_offsets_[num_edges_] = static_cast<uint32_t>(edge_shape_points_.size());

    for (uint32_t u = 0; u < num_nodes_; ++u) {
        row_offsets_[static_cast<size_t>(u) + 1U] += row_offsets_[u];
    }

    // Build reverse CSR representation pointing to forward edge indices
    rev_row_offsets_.assign(static_cast<size_t>(num_nodes_) + 1U, 0U);
    for (uint32_t e = 0; e < num_edges_; ++e) {
        const uint32_t v = col_indices_[e];
        ++rev_row_offsets_[static_cast<size_t>(v) + 1U];
    }
    for (uint32_t v = 0; v < num_nodes_; ++v) {
        rev_row_offsets_[static_cast<size_t>(v) + 1U] += rev_row_offsets_[v];
    }

    rev_col_indices_.resize(num_edges_);
    rev_edge_indices_.resize(num_edges_);
    std::vector<uint32_t> write_cursor = rev_row_offsets_;
    for (uint32_t u = 0; u < num_nodes_; ++u) {
        for (uint32_t e = row_offsets_[u]; e < row_offsets_[static_cast<size_t>(u) + 1U]; ++e) {
            const uint32_t v = col_indices_[e];
            const uint32_t pos = write_cursor[v]++;
            rev_col_indices_[pos] = u;
            rev_edge_indices_[pos] = e;
        }
    }

    // Initialize default snapshot (all multipliers = 1.0f)
    auto initial_snapshot = std::make_shared<EdgeWeightSnapshot>();
    initial_snapshot->version = 1;
    initial_snapshot->timestamp_unix = 0;
    initial_snapshot->speed_multipliers.assign(num_edges_, 1.0f);
    active_snapshot_.store(std::move(initial_snapshot), std::memory_order_release);

    locked_multipliers_.assign(num_edges_, 1.0f);
}

uint32_t CsrGraph::update_speed_multipliers(std::span<const EdgeMultiplierUpdate> updates,
                                            int64_t timestamp_unix) {
    std::lock_guard<std::mutex> writer_guard(writer_mutex_);

    auto current = active_snapshot_.load(std::memory_order_acquire);
    auto next_snap = std::make_shared<EdgeWeightSnapshot>();
    if (current) {
        next_snap->version = current->version + 1U;
        next_snap->speed_multipliers = current->speed_multipliers;
    } else {
        next_snap->version = 1U;
        next_snap->speed_multipliers.assign(num_edges_, 1.0f);
    }
    next_snap->timestamp_unix = timestamp_unix;

    uint32_t applied = 0;
    for (const auto& upd : updates) {
        const float clamped = std::clamp(upd.speed_multiplier, 0.05f, 10.0f);
        auto it = edge_id_to_index_.find(upd.edge_id);
        if (it != edge_id_to_index_.end()) {
            next_snap->speed_multipliers[it->second] = clamped;
            ++applied;
        } else if (upd.edge_id >= 0 &&
                   static_cast<uint64_t>(upd.edge_id) < static_cast<uint64_t>(num_edges_)) {
            next_snap->speed_multipliers[static_cast<size_t>(upd.edge_id)] = clamped;
            ++applied;
        }
    }

    active_snapshot_.store(std::move(next_snap), std::memory_order_release);
    return applied;
}

uint32_t CsrGraph::replace_all_speed_multipliers(std::span<const float> multipliers,
                                                 int64_t timestamp_unix) {
    std::lock_guard<std::mutex> writer_guard(writer_mutex_);

    auto current = active_snapshot_.load(std::memory_order_acquire);
    auto next_snap = std::make_shared<EdgeWeightSnapshot>();
    next_snap->version = current ? (current->version + 1U) : 1U;
    next_snap->timestamp_unix = timestamp_unix;
    next_snap->speed_multipliers.assign(num_edges_, 1.0f);

    const uint32_t count = std::min<uint32_t>(
        num_edges_, static_cast<uint32_t>(multipliers.size()));
    for (uint32_t i = 0; i < count; ++i) {
        next_snap->speed_multipliers[i] = std::clamp(multipliers[i], 0.05f, 10.0f);
    }

    active_snapshot_.store(std::move(next_snap), std::memory_order_release);
    return count;
}

int64_t CsrGraph::effective_duration_ms_shared_lock(uint32_t edge_index) const {
    if (edge_index >= num_edges_) return 0;
    std::shared_lock<std::shared_mutex> read_lock(rw_mutex_);
    const float mult = std::clamp(locked_multipliers_[edge_index], 0.05f, 10.0f);
    const double scaled =
        static_cast<double>(base_edges_[edge_index].base_duration_ms) / static_cast<double>(mult);
    return std::max<int64_t>(1, static_cast<int64_t>(std::llround(scaled)));
}

uint32_t CsrGraph::update_speed_multipliers_shared_lock(
    std::span<const EdgeMultiplierUpdate> updates) {
    std::unique_lock<std::shared_mutex> write_lock(rw_mutex_);
    uint32_t applied = 0;
    for (const auto& upd : updates) {
        const float clamped = std::clamp(upd.speed_multiplier, 0.05f, 10.0f);
        auto it = edge_id_to_index_.find(upd.edge_id);
        if (it != edge_id_to_index_.end()) {
            locked_multipliers_[it->second] = clamped;
            ++applied;
        } else if (upd.edge_id >= 0 &&
                   static_cast<uint64_t>(upd.edge_id) < static_cast<uint64_t>(num_edges_)) {
            locked_multipliers_[static_cast<size_t>(upd.edge_id)] = clamped;
            ++applied;
        }
    }
    return applied;
}

double CsrGraph::haversine_meters(NodeCoord a, NodeCoord b) noexcept {
    constexpr double kEarthRadiusMeters = 6371000.0;
    constexpr double kDegToRad = std::numbers::pi / 180.0;

    const double dlat = (b.latitude - a.latitude) * kDegToRad;
    const double dlon = (b.longitude - a.longitude) * kDegToRad;
    const double lat1 = a.latitude * kDegToRad;
    const double lat2 = b.latitude * kDegToRad;

    const double sin_dlat = std::sin(dlat * 0.5);
    const double sin_dlon = std::sin(dlon * 0.5);
    const double h = sin_dlat * sin_dlat +
                     std::cos(lat1) * std::cos(lat2) * sin_dlon * sin_dlon;
    const double c = 2.0 * std::atan2(std::sqrt(std::max(0.0, h)),
                                      std::sqrt(std::max(0.0, 1.0 - h)));
    return kEarthRadiusMeters * c;
}

uint32_t CsrGraph::find_nearest_node(NodeCoord coord) const noexcept {
    if (num_nodes_ == 0) return 0;
    uint32_t best_node = 0;
    double best_dist = std::numeric_limits<double>::max();
    for (uint32_t u = 0; u < num_nodes_; ++u) {
        const double d = haversine_meters(coord, node_coords_[u]);
        if (d < best_dist) {
            best_dist = d;
            best_node = u;
        }
    }
    return best_node;
}

std::shared_ptr<CsrGraph> CsrGraph::create_synthetic_grid(
    uint32_t rows, uint32_t cols,
    double origin_lat, double origin_lon,
    double step_deg) {
    rows = std::max<uint32_t>(2, rows);
    cols = std::max<uint32_t>(2, cols);
    const uint32_t total_nodes = rows * cols;

    std::vector<NodeCoord> coords(total_nodes);
    for (uint32_t r = 0; r < rows; ++r) {
        for (uint32_t c = 0; c < cols; ++c) {
            const uint32_t u = r * cols + c;
            coords[u] = NodeCoord{
                origin_lat + static_cast<double>(r) * step_deg,
                origin_lon + static_cast<double>(c) * step_deg,
            };
        }
    }

    std::vector<RawEdge> edges;
    edges.reserve(static_cast<size_t>(total_nodes) * 6U);
    int64_t next_edge_id = 1000;

    auto add_directed_edge = [&](uint32_t u, uint32_t v, double speed_mps, uint8_t road_class) {
        const double dist_m = std::max(10.0, haversine_meters(coords[u], coords[v]));
        const int64_t duration_ms =
            std::max<int64_t>(50, static_cast<int64_t>(std::llround((dist_m / speed_mps) * 1000.0)));
        edges.push_back(RawEdge{
            u,
            v,
            next_edge_id++,
            duration_ms,
             static_cast<int64_t>(std::llround(dist_m)),
            road_class,
        });
    };

    for (uint32_t r = 0; r < rows; ++r) {
        for (uint32_t c = 0; c < cols; ++c) {
            const uint32_t u = r * cols + c;
            // Arterial avenues every 3rd row/col move faster (18 m/s vs 11 m/s)
            const double ew_speed = (r % 3 == 0) ? 18.0 : 11.5;
            const double ns_speed = (c % 3 == 0) ? 17.5 : 11.0;

            if (c + 1 < cols) {
                add_directed_edge(u, u + 1, ew_speed, (r % 3 == 0) ? 1 : 2);
                // Asymmetric reverse travel speed
                add_directed_edge(u + 1, u, ew_speed * 0.92, (r % 3 == 0) ? 1 : 2);
            }
            if (r + 1 < rows) {
                add_directed_edge(u, u + cols, ns_speed, (c % 3 == 0) ? 1 : 2);
                add_directed_edge(u + cols, u, ns_speed * 0.95, (c % 3 == 0) ? 1 : 2);
            }
            // Diagonal express connectors on major intersections
            if ((r % 3 == 0) && (c % 3 == 0) && (r + 1 < rows) && (c + 1 < cols)) {
                add_directed_edge(u, (r + 1) * cols + (c + 1), 20.0, 0);
                add_directed_edge((r + 1) * cols + (c + 1), u, 19.5, 0);
            }
        }
    }

    return std::make_shared<CsrGraph>(total_nodes, edges, std::move(coords));
}

std::shared_ptr<CsrGraph> CsrGraph::create_curved_urban_network(
    double center_lat, double center_lon,
    uint32_t rings, uint32_t spokes,
    double outer_radius_m) {
    rings = std::clamp<uint32_t>(rings, 2U, 8U);
    spokes = std::clamp<uint32_t>(spokes, 6U, 24U);
    outer_radius_m = std::clamp(outer_radius_m, 1200.0, 20000.0);

    const double cos_lat = std::max(0.2, std::cos(center_lat * std::numbers::pi / 180.0));
    auto meters_to_lat = [](double m) noexcept { return m / 111320.0; };
    auto meters_to_lon = [cos_lat](double m) noexcept { return m / (111320.0 * cos_lat); };
    const double phase = center_lat * 0.13 + center_lon * 0.07;

    auto spoke_angle = [spokes](uint32_t s, double ring_frac) noexcept {
        const double base_theta =
            (static_cast<double>(s) / static_cast<double>(spokes)) * 2.0 * std::numbers::pi;
        const double sway =
            std::sin(ring_frac * std::numbers::pi) * 0.14 * ((s % 2U == 0U) ? 1.0 : -1.0);
        return base_theta + sway;
    };

    auto ring_point = [&](double base_r, double theta) noexcept -> NodeCoord {
        const double organic =
            1.0 + 0.075 * std::sin(3.0 * theta + phase) +
            0.045 * std::cos(5.0 * theta - phase * 0.6);
        const double r = base_r * organic;
        return NodeCoord{
            center_lat + meters_to_lat(r * std::sin(theta)),
            center_lon + meters_to_lon(r * std::cos(theta) * 1.06),
        };
    };

    auto sample_bezier = [](NodeCoord p0, NodeCoord ctrl, NodeCoord p2, uint32_t steps) {
        std::vector<NodeCoord> pts;
        pts.reserve(static_cast<size_t>(steps) + 1U);
        for (uint32_t i = 0; i <= steps; ++i) {
            const double t = static_cast<double>(i) / static_cast<double>(steps);
            const double u = 1.0 - t;
            pts.push_back(NodeCoord{
                u * u * p0.latitude + 2.0 * u * t * ctrl.latitude + t * t * p2.latitude,
                u * u * p0.longitude + 2.0 * u * t * ctrl.longitude + t * t * p2.longitude,
            });
        }
        return pts;
    };

    // Node 0 = city center core; Nodes 1 .. rings*spokes = curved ring intersections
    const uint32_t total_nodes = 1U + rings * spokes;
    std::vector<NodeCoord> coords(total_nodes);
    coords[0] = NodeCoord{center_lat, center_lon};

    std::vector<double> ring_radii(rings);
    for (uint32_t r = 0; r < rings; ++r) {
        const double frac = static_cast<double>(r + 1U) / static_cast<double>(rings);
        ring_radii[r] = outer_radius_m * (0.22 + 0.78 * frac);
        for (uint32_t s = 0; s < spokes; ++s) {
            const uint32_t nid = 1U + r * spokes + s;
            coords[nid] = ring_point(ring_radii[r], spoke_angle(s, frac));
        }
    }

    std::vector<RawEdge> edges;
    edges.reserve(static_cast<size_t>(total_nodes) * 6U);
    int64_t next_edge_id = 1000;

    auto add_curved_bidirectional = [&](uint32_t u, uint32_t v,
                                        std::vector<NodeCoord> shape,
                                        double speed_mps, uint8_t road_class) {
        double arc_dist_m = 0.0;
        for (size_t i = 0; i + 1U < shape.size(); ++i) {
            arc_dist_m += haversine_meters(shape[i], shape[i + 1U]);
        }
        arc_dist_m = std::max(10.0, arc_dist_m);
        const int64_t fwd_dur_ms = std::max<int64_t>(
            50, static_cast<int64_t>(std::llround((arc_dist_m / speed_mps) * 1000.0)));
        const int64_t rev_dur_ms = std::max<int64_t>(
            50, static_cast<int64_t>(std::llround((arc_dist_m / (speed_mps * 0.94)) * 1000.0)));
        const int64_t dist_i64 = static_cast<int64_t>(std::llround(arc_dist_m));

        std::vector<NodeCoord> rev_shape(shape.rbegin(), shape.rend());
        edges.push_back(RawEdge{u, v, next_edge_id++, fwd_dur_ms, dist_i64, road_class, std::move(shape)});
        edges.push_back(RawEdge{v, u, next_edge_id++, rev_dur_ms, dist_i64, road_class, std::move(rev_shape)});
    };

    // 1. Curved orbital beltways
    for (uint32_t r = 0; r < rings; ++r) {
        const double frac = static_cast<double>(r + 1U) / static_cast<double>(rings);
        const double ring_speed = (r + 1U == rings) ? 18.0 : ((r == 1U) ? 14.0 : 11.5);
        const uint8_t cls = (r + 1U == rings) ? 0U : 1U;
        for (uint32_t s = 0; s < spokes; ++s) {
            const uint32_t s_next = (s + 1U) % spokes;
            const uint32_t u = 1U + r * spokes + s;
            const uint32_t v = 1U + r * spokes + s_next;
            const double t0 = spoke_angle(s, frac);
            double t1 = spoke_angle(s_next, frac);
            if (t1 <= t0) t1 += 2.0 * std::numbers::pi;

            std::vector<NodeCoord> arc;
            constexpr uint32_t kArcSteps = 6U;
            arc.reserve(kArcSteps + 1U);
            for (uint32_t k = 0; k <= kArcSteps; ++k) {
                const double theta = t0 + (t1 - t0) * (static_cast<double>(k) / kArcSteps);
                arc.push_back(ring_point(ring_radii[r], theta));
            }
            arc.front() = coords[u];
            arc.back() = coords[v];
            add_curved_bidirectional(u, v, std::move(arc), ring_speed, cls);
        }
    }

    // 2. Curved radial arterial spokes
    for (uint32_t s = 0; s < spokes; ++s) {
        const double spoke_speed = (s % 2U == 0U) ? 15.0 : 11.5;
        const uint8_t cls = (s % 2U == 0U) ? 1U : 2U;

        // Center -> Ring 0 curved approach
        const uint32_t first_ring_node = 1U + s;
        const double mid_theta = spoke_angle(s, 0.12) + ((s % 2U == 0U) ? 0.08 : -0.08);
        const NodeCoord ctrl0 = ring_point(ring_radii[0] * 0.52, mid_theta);
        add_curved_bidirectional(
            0U, first_ring_node, sample_bezier(coords[0], ctrl0, coords[first_ring_node], 5U),
            spoke_speed, cls);

        // Ring r -> Ring r+1 curved arterial
        for (uint32_t r = 0; r + 1U < rings; ++r) {
            const uint32_t u = 1U + r * spokes + s;
            const uint32_t v = 1U + (r + 1U) * spokes + s;
            const double dlat = coords[v].latitude - coords[u].latitude;
            const double dlon = coords[v].longitude - coords[u].longitude;
            const double bend_sign = ((s + r) % 2U == 0U) ? 1.0 : -1.0;
            const NodeCoord ctrl{
                (coords[u].latitude + coords[v].latitude) * 0.5 + dlon * 0.12 * bend_sign,
                (coords[u].longitude + coords[v].longitude) * 0.5 - dlat * 0.16 * bend_sign,
            };
            add_curved_bidirectional(
                u, v, sample_bezier(coords[u], ctrl, coords[v], 5U), spoke_speed, cls);
        }
    }

    // 3. Curved cross-town diagonal connectors between alternating rings
    if (rings >= 3U) {
        for (uint32_t s = 0; s < spokes; s += 2U) {
            const uint32_t u = 1U + 0U * spokes + s;
            const uint32_t mid = 1U + 1U * spokes + ((s + 1U) % spokes);
            const uint32_t v = 1U + 2U * spokes + ((s + 2U) % spokes);
            add_curved_bidirectional(
                u, v, sample_bezier(coords[u], coords[mid], coords[v], 6U), 12.5, 2U);
        }
    }

    return std::make_shared<CsrGraph>(total_nodes, edges, std::move(coords));
}

std::shared_ptr<CsrGraph> CsrGraph::load_from_json_file(const std::string& path) {
    std::ifstream in(path);
    if (!in.is_open()) {
        return nullptr;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    const std::string text = ss.str();

    auto find_array_bounds = [&](const std::string& key) -> std::pair<size_t, size_t> {
        const size_t kpos = text.find("\"" + key + "\"");
        if (kpos == std::string::npos) return {std::string::npos, std::string::npos};
        const size_t start = text.find('[', kpos);
        if (start == std::string::npos) return {std::string::npos, std::string::npos};
        int depth = 0;
        for (size_t i = start; i < text.size(); ++i) {
            if (text[i] == '[') ++depth;
            else if (text[i] == ']') {
                --depth;
                if (depth == 0) return {start + 1U, i};
            }
        }
        return {std::string::npos, std::string::npos};
    };

    const auto [nodes_b, nodes_e] = find_array_bounds("nodes");
    const auto [edges_b, edges_e] = find_array_bounds("edges");
    if (nodes_b == std::string::npos || edges_b == std::string::npos) {
        return nullptr;
    }

    // Parse "nodes": [[lon, lat], ...]
    std::vector<NodeCoord> coords;
    for (size_t i = nodes_b; i < nodes_e; ++i) {
        if (text[i] == '[') {
            const size_t close = text.find(']', i);
            if (close == std::string::npos || close > nodes_e) break;
            const size_t comma = text.find(',', i);
            if (comma != std::string::npos && comma < close) {
                const double lon = std::strtod(text.c_str() + i + 1U, nullptr);
                const double lat = std::strtod(text.c_str() + comma + 1U, nullptr);
                if (std::isfinite(lat) && std::isfinite(lon) &&
                    lat >= -90.0 && lat <= 90.0 && lon >= -180.0 && lon <= 180.0) {
                    coords.push_back(NodeCoord{lat, lon});
                }
            }
            i = close;
        }
    }

    if (coords.size() < 2U) {
        return nullptr;
    }

    // Parse "edges": [[u, v, "class", oneway, speed_mps], ...]
    std::vector<RawEdge> edges;
    int64_t next_edge_id = 1;
    for (size_t i = edges_b; i < edges_e; ++i) {
        if (text[i] == '[') {
            const size_t close = text.find(']', i);
            if (close == std::string::npos || close > edges_e) break;
            const std::string entry = text.substr(i + 1U, close - i - 1U);
            std::vector<std::string> fields;
            std::stringstream es(entry);
            std::string tok;
            while (std::getline(es, tok, ',')) {
                fields.push_back(tok);
            }
            if (fields.size() >= 5U) {
                const uint32_t u = static_cast<uint32_t>(std::strtoul(fields[0].c_str(), nullptr, 10));
                const uint32_t v = static_cast<uint32_t>(std::strtoul(fields[1].c_str(), nullptr, 10));
                const bool oneway = fields[3].find("true") != std::string::npos;
                const double speed_mps = std::clamp(std::strtod(fields[4].c_str(), nullptr), 3.0, 30.0);
                if (u < coords.size() && v < coords.size() && u != v) {
                    const double dist_m = std::max(5.0, haversine_meters(coords[u], coords[v]));
                    const int64_t dur_ms = std::max<int64_t>(
                        50, static_cast<int64_t>(std::llround((dist_m / speed_mps) * 1000.0)));
                    const int64_t dist_i64 = static_cast<int64_t>(std::llround(dist_m));
                    edges.push_back(RawEdge{u, v, next_edge_id++, dur_ms, dist_i64, 1U, {coords[u], coords[v]}});
                    if (!oneway) {
                        edges.push_back(RawEdge{v, u, next_edge_id++, dur_ms, dist_i64, 1U, {coords[v], coords[u]}});
                    }
                }
            }
            i = close;
        }
    }

    if (edges.empty()) {
        return nullptr;
    }

    return std::make_shared<CsrGraph>(static_cast<uint32_t>(coords.size()), edges, std::move(coords));
}

} // namespace chronos
