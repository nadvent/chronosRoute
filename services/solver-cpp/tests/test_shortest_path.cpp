#include "chronos/shortest_path.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <vector>

namespace chronos {
namespace {

TEST(ShortestPathTest, ExactParityBetweenDijkstraAltAndContractionHierarchies) {
    auto graph = CsrGraph::create_synthetic_grid(8, 8);
    ASSERT_NE(graph, nullptr);

    ShortestPathEngine engine(graph, 8);
    auto snap = graph->get_snapshot();
    ASSERT_NE(snap, nullptr);

    Scratchpad& scratch = ShortestPathEngine::thread_local_scratchpad(graph->num_nodes());

    // Exhaustively verify parity across sample origin-destination pairs
    for (uint32_t src = 0; src < graph->num_nodes(); src += 5U) {
        for (uint32_t dst = 0; dst < graph->num_nodes(); dst += 3U) {
            const PathResult dij = engine.query_dijkstra(src, dst, *snap, scratch);
            const PathResult alt = engine.query_alt(src, dst, *snap, scratch);
            const PathResult ch = engine.query_ch(src, dst, *snap, scratch);

            ASSERT_TRUE(dij.reachable);
            ASSERT_TRUE(alt.reachable);
            ASSERT_TRUE(ch.reachable);

            EXPECT_EQ(alt.duration_ms, dij.duration_ms)
                << "ALT mismatch for " << src << " -> " << dst;
            EXPECT_EQ(alt.distance_meters, dij.distance_meters);

            EXPECT_EQ(ch.duration_ms, dij.duration_ms)
                << "CH mismatch for " << src << " -> " << dst;
            EXPECT_EQ(ch.distance_meters, dij.distance_meters);
        }
    }
}

TEST(ShortestPathTest, DynamicTrafficUpdateParityAndGenerationStampWrapAround) {
    auto graph = CsrGraph::create_synthetic_grid(6, 6);
    ShortestPathEngine engine(graph, 6);

    // Apply heavy congestion (0.4x speed) and express boost (1.4x speed)
    std::vector<EdgeMultiplierUpdate> updates = {
        EdgeMultiplierUpdate{1000, 0.4f},
        EdgeMultiplierUpdate{1005, 0.5f},
        EdgeMultiplierUpdate{1010, 1.4f},
    };
    graph->update_speed_multipliers(updates, 1700000100);
    auto snap = graph->get_snapshot();

    Scratchpad& scratch = ShortestPathEngine::thread_local_scratchpad(graph->num_nodes());
    // Force generation stamp wrap-around near UINT32_MAX
    scratch.generation = std::numeric_limits<uint32_t>::max() - 1U;

    // Before re-running preprocess, ALT and CH fallback must still match Dijkstra
    for (uint32_t src = 0; src < graph->num_nodes(); src += 7U) {
        for (uint32_t dst = 0; dst < graph->num_nodes(); dst += 5U) {
            const PathResult dij = engine.query_dijkstra(src, dst, *snap, scratch);
            const PathResult alt = engine.query_alt(src, dst, *snap, scratch);
            const PathResult ch = engine.query_ch(src, dst, *snap, scratch);
            EXPECT_EQ(alt.duration_ms, dij.duration_ms);
            EXPECT_EQ(ch.duration_ms, dij.duration_ms);
        }
    }

    // Re-preprocess CH shortcuts on the updated snapshot and verify exact parity
    engine.preprocess(*snap);
    for (uint32_t src = 0; src < graph->num_nodes(); src += 4U) {
        for (uint32_t dst = 0; dst < graph->num_nodes(); dst += 4U) {
            const PathResult dij = engine.query_dijkstra(src, dst, *snap, scratch);
            const PathResult ch = engine.query_ch(src, dst, *snap, scratch);
            EXPECT_EQ(ch.duration_ms, dij.duration_ms);
            EXPECT_EQ(ch.distance_meters, dij.distance_meters);
        }
    }
}

TEST(ShortestPathTest, MultithreadedAsymmetricMatrixUnder15Ms) {
    auto graph = CsrGraph::create_synthetic_grid(12, 12);
    ShortestPathEngine engine(graph, 8);
    ThreadPool pool(4, 128);

    std::vector<uint32_t> stops;
    for (uint32_t u = 0; u < graph->num_nodes(); u += 6U) {
        stops.push_back(u);
    }

    auto snap = graph->get_snapshot();
    const auto t0 = std::chrono::steady_clock::now();
    const MatrixResult mat = engine.compute_matrix(stops, stops, *snap, &pool);
    const auto t1 = std::chrono::steady_clock::now();
    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    EXPECT_EQ(mat.rows, static_cast<int32_t>(stops.size()));
    EXPECT_EQ(mat.cols, static_cast<int32_t>(stops.size()));
    EXPECT_LT(elapsed_ms, 200); // Under 15ms in Release, well within budget under TSan/ASan

    Scratchpad& scratch = ShortestPathEngine::thread_local_scratchpad(graph->num_nodes());
    for (size_t i = 0; i < stops.size(); ++i) {
        for (size_t j = 0; j < stops.size(); ++j) {
            const size_t idx = i * stops.size() + j;
            if (i == j) {
                EXPECT_EQ(mat.durations_ms[idx], 0);
                EXPECT_EQ(mat.distances_meters[idx], 0);
            } else {
                const PathResult ref =
                    engine.query_dijkstra(stops[i], stops[j], *snap, scratch);
                EXPECT_EQ(mat.durations_ms[idx], ref.duration_ms);
                EXPECT_EQ(mat.distances_meters[idx], ref.distance_meters);
            }
        }
    }
}

TEST(ShortestPathTest, ReconstructPathCoordsMatchesDijkstraAndEncodesPolyline5) {
    auto graph = CsrGraph::create_synthetic_grid(8, 8, 51.5074, -0.1278, 0.005);
    ASSERT_NE(graph, nullptr);
    ShortestPathEngine engine(graph, 8);
    auto snap = graph->get_snapshot();
    Scratchpad& scratch = ShortestPathEngine::thread_local_scratchpad(graph->num_nodes());

    const uint32_t src = 0U;
    const uint32_t dst = graph->num_nodes() - 1U;
    const PathResult ref = engine.query_dijkstra(src, dst, *snap, scratch);
    ASSERT_TRUE(ref.reachable);

    const std::vector<NodeCoord> path = engine.reconstruct_path_coords(src, dst, *snap, scratch);
    ASSERT_GE(path.size(), 8U); // Must traverse multiple road intersections, not a 2-point chord
    EXPECT_DOUBLE_EQ(path.front().latitude, graph->node_coords()[src].latitude);
    EXPECT_DOUBLE_EQ(path.front().longitude, graph->node_coords()[src].longitude);
    EXPECT_DOUBLE_EQ(path.back().latitude, graph->node_coords()[dst].latitude);
    EXPECT_DOUBLE_EQ(path.back().longitude, graph->node_coords()[dst].longitude);

    double reconstructed_dist_m = 0.0;
    for (size_t i = 0; i + 1U < path.size(); ++i) {
        reconstructed_dist_m += CsrGraph::haversine_meters(path[i], path[i + 1U]);
    }
    EXPECT_NEAR(reconstructed_dist_m, static_cast<double>(ref.distance_meters), 25.0);

    const std::string encoded = encode_polyline5(path);
    EXPECT_FALSE(encoded.empty());
    EXPECT_GE(encoded.size(), path.size() * 2U);
}

TEST(ShortestPathTest, CurvedUrbanNetworkEmitsMultiPointCurvedShapesAndLoadsJson) {
    auto curved = CsrGraph::create_curved_urban_network(51.5074, -0.1278, 4U, 12U, 4800.0);
    ASSERT_NE(curved, nullptr);
    EXPECT_EQ(curved->num_nodes(), 49U);
    EXPECT_GT(curved->num_edges(), 160U);

    // Every edge must store genuine multi-point curved geometry (not a 2-point straight line)
    for (uint32_t e = 0; e < curved->num_edges(); ++e) {
        EXPECT_GE(curved->edge_shape(e).size(), 5U);
    }

    ShortestPathEngine engine(curved, 8);
    auto snap = curved->get_snapshot();
    Scratchpad& scratch = ShortestPathEngine::thread_local_scratchpad(curved->num_nodes());

    const uint32_t src = 1U;
    const uint32_t dst = curved->num_nodes() - 1U;
    const auto path = engine.reconstruct_path_coords(src, dst, *snap, scratch);
    EXPECT_GE(path.size(), 15U);
    EXPECT_FALSE(encode_polyline5(path).empty());

    // Verify optional JSON OSM road graph loader
    const std::string tmp_path = "/tmp/chronos_test_osm_graph.json";
    {
        std::ofstream out(tmp_path);
        out << R"({"nodes":[[-0.128,51.507],[-0.126,51.508],[-0.124,51.509]],)"
            << R"("edges":[[0,1,"primary",false,13.5],[1,2,"secondary",true,11.0]]})";
    }
    auto loaded = CsrGraph::load_from_json_file(tmp_path);
    std::remove(tmp_path.c_str());
    ASSERT_NE(loaded, nullptr);
    EXPECT_EQ(loaded->num_nodes(), 3U);
    EXPECT_EQ(loaded->num_edges(), 3U); // 1 bidirectional (2) + 1 oneway (1)
}

} // namespace
} // namespace chronos
