#include "chronos/csr_graph.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <thread>
#include <vector>

namespace chronos {
namespace {

TEST(GraphSnapshotTest, CsrContiguousLayoutAndO1DegreeLookup) {
    std::vector<RawEdge> edges = {
        RawEdge{0, 1, 100, 1000, 200, 1},
        RawEdge{0, 2, 101, 2000, 400, 1},
        RawEdge{1, 2, 102, 1500, 300, 2},
        RawEdge{2, 3, 103, 1200, 250, 1},
        RawEdge{3, 0, 104, 3000, 600, 2},
    };

    CsrGraph graph(4, edges);
    EXPECT_EQ(graph.num_nodes(), 4U);
    EXPECT_EQ(graph.num_edges(), 5U);
    ASSERT_EQ(graph.row_offsets().size(), 5U);

    EXPECT_EQ(graph.out_degree(0), 2U);
    EXPECT_EQ(graph.out_degree(1), 1U);
    EXPECT_EQ(graph.out_degree(2), 1U);
    EXPECT_EQ(graph.out_degree(3), 1U);

    const auto [e0_begin, e0_end] = graph.outgoing_edge_range(0);
    EXPECT_EQ(e0_begin, 0U);
    EXPECT_EQ(e0_end, 2U);
    EXPECT_EQ(graph.col_indices()[0], 1U);
    EXPECT_EQ(graph.col_indices()[1], 2U);
}

TEST(GraphSnapshotTest, CopyOnWriteSnapshotIsolation) {
    std::vector<RawEdge> edges = {
        RawEdge{0, 1, 501, 1000, 100, 1},
        RawEdge{1, 2, 502, 2000, 200, 1},
    };
    CsrGraph graph(3, edges);

    auto snap_v1 = graph.get_snapshot();
    ASSERT_NE(snap_v1, nullptr);
    EXPECT_EQ(snap_v1->version, 1U);
    EXPECT_EQ(graph.effective_duration_ms(0, *snap_v1), 1000);

    // Apply 0.5x speed multiplier on edge_id 501 -> travel time doubles to 2000ms
    const std::vector<EdgeMultiplierUpdate> updates = {
        EdgeMultiplierUpdate{501, 0.5f},
    };
    const uint32_t count = graph.update_speed_multipliers(updates, 1700000000);
    EXPECT_EQ(count, 1U);

    auto snap_v2 = graph.get_snapshot();
    ASSERT_NE(snap_v2, nullptr);
    EXPECT_EQ(snap_v2->version, 2U);
    EXPECT_EQ(graph.effective_duration_ms(0, *snap_v2), 2000);

    // Original reader holding snap_v1 remains completely isolated
    EXPECT_EQ(snap_v1->version, 1U);
    EXPECT_EQ(graph.effective_duration_ms(0, *snap_v1), 1000);

    // Verify shared_mutex baseline parity
    EXPECT_EQ(graph.update_speed_multipliers_shared_lock(updates), 1U);
    EXPECT_EQ(graph.effective_duration_ms_shared_lock(0), 2000);
}

TEST(GraphSnapshotTest, MultithreadedWaitFreeReadersAndAtomicWritersUnderTSan) {
    auto graph = CsrGraph::create_synthetic_grid(10, 10);
    ASSERT_NE(graph, nullptr);
    const uint32_t num_edges = graph->num_edges();
    ASSERT_GT(num_edges, 0U);

    std::atomic<bool> start_flag{false};
    std::atomic<uint64_t> total_reads{0};

    // 8 concurrent reader threads performing wait-free snapshot loads
    std::vector<std::jthread> readers;
    readers.reserve(8);
    for (int r = 0; r < 8; ++r) {
        readers.emplace_back([&, r]() {
            while (!start_flag.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            uint64_t local_reads = 0;
            uint64_t prev_version = 1;
            for (int iter = 0; iter < 1500; ++iter) {
                auto snap = graph->get_snapshot();
                ASSERT_NE(snap, nullptr);
                EXPECT_GE(snap->version, prev_version);
                prev_version = snap->version;

                const uint32_t e_idx =
                    (static_cast<uint32_t>(iter) + static_cast<uint32_t>(r) * 17U) % num_edges;
                const int64_t dur = graph->effective_duration_ms(e_idx, *snap);
                EXPECT_GT(dur, 0);
                ++local_reads;
            }
            total_reads.fetch_add(local_reads, std::memory_order_relaxed);
        });
    }

    // 2 concurrent writer threads atomically swapping EdgeWeightSnapshots
    std::vector<std::jthread> writers;
    writers.reserve(2);
    for (int w = 0; w < 2; ++w) {
        writers.emplace_back([&, w]() {
            while (!start_flag.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            for (int step = 0; step < 80; ++step) {
                const float mult = (step % 2 == 0) ? 0.65f : 1.15f;
                std::vector<EdgeMultiplierUpdate> batch;
                batch.reserve(16);
                for (uint32_t i = 0; i < 16U; ++i) {
                    const int64_t eid = static_cast<int64_t>(
                        (static_cast<uint32_t>(step * 7 + w * 13) + i) % num_edges);
                    batch.push_back(EdgeMultiplierUpdate{eid, mult});
                }
                graph->update_speed_multipliers(batch, 1700000000 + step);
            }
        });
    }

    start_flag.store(true, std::memory_order_release);
    for (auto& w : writers) {
        w.join();
    }
    for (auto& r : readers) {
        r.join();
    }

    EXPECT_EQ(total_reads.load(), 8ULL * 1500ULL);
    EXPECT_GT(graph->get_snapshot()->version, 100U);
}

} // namespace
} // namespace chronos
