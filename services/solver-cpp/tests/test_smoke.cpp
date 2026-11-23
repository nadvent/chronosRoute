#include "chronos/chronos.hpp"
#include "chronos/csr_graph.hpp"

#include <gtest/gtest.h>

namespace chronos {
namespace {

TEST(SmokeTest, EngineConstantsAndGridSanity) {
    EXPECT_EQ(kDefaultPort, 50051);
    EXPECT_GE(kDefaultWorkerThreads, 1U);
    EXPECT_GE(kDefaultMaxQueueCapacityPerWorker, 64U);
    EXPECT_EQ(kDefaultSolverDeadlineMs, 500);
    EXPECT_EQ(kTraceIdHeader, "x-trace-id");

    auto graph = CsrGraph::create_synthetic_grid(4, 4);
    ASSERT_NE(graph, nullptr);
    EXPECT_EQ(graph->num_nodes(), 16U);
    EXPECT_GT(graph->num_edges(), 24U);
}

} // namespace
} // namespace chronos
