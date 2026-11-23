#pragma once

// ============================================================================
// [CO-AUTHORED] gRPC RoutingService Implementation & Deadline/Trace Propagation
// ============================================================================

#include "chronos/alns_solver.hpp"
#include "chronos/chronos.hpp"
#include "chronos/csr_graph.hpp"
#include "chronos/onnx_scorer.hpp"
#include "chronos/shortest_path.hpp"
#include "chronos/thread_pool.hpp"

#include "routing_service.grpc.pb.h"
#include "routing_service.pb.h"

#include <grpcpp/grpcpp.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

namespace chronos {

class RoutingServiceImpl final : public chronos::routing::v1::RoutingService::Service {
public:
    explicit RoutingServiceImpl(
        std::shared_ptr<CsrGraph> graph = CsrGraph::create_synthetic_grid(),
        uint32_t num_workers = kDefaultWorkerThreads,
        const std::string& onnx_model_path = "");

    ~RoutingServiceImpl() override = default;

    grpc::Status SolveCVRPTW(
        grpc::ServerContext* context,
        const chronos::routing::v1::CVRPTWRequest* request,
        chronos::routing::v1::CVRPTWResponse* response) override;

    grpc::Status UpdateTrafficMultipliers(
        grpc::ServerContext* context,
        const chronos::routing::v1::TrafficUpdateRequest* request,
        chronos::routing::v1::TrafficUpdateResponse* response) override;

    grpc::Status ComputeDistanceMatrix(
        grpc::ServerContext* context,
        const chronos::routing::v1::MatrixRequest* request,
        chronos::routing::v1::MatrixResponse* response) override;

    grpc::Status CheckHealth(
        grpc::ServerContext* context,
        const chronos::routing::v1::HealthRequest* request,
        chronos::routing::v1::HealthResponse* response) override;

    [[nodiscard]] std::shared_ptr<CsrGraph> graph() const noexcept { return graph_; }
    [[nodiscard]] std::shared_ptr<ShortestPathEngine> sp_engine() const noexcept { return sp_engine_; }
    [[nodiscard]] ThreadPool& thread_pool() noexcept { return *pool_; }
    [[nodiscard]] const OnnxEdgeScorer& onnx_scorer() const noexcept { return *scorer_; }

    [[nodiscard]] std::string last_trace_id() const;
    [[nodiscard]] int64_t total_solved_requests() const noexcept {
        return total_solved_requests_.load(std::memory_order_relaxed);
    }

private:
    std::string extract_and_propagate_trace_id(grpc::ServerContext* context);

    std::shared_ptr<CsrGraph> graph_;
    std::shared_ptr<ShortestPathEngine> sp_engine_;
    std::unique_ptr<ThreadPool> pool_;
    std::unique_ptr<OnnxEdgeScorer> scorer_;

    std::atomic<int64_t> total_solved_requests_{0};
    std::atomic<int64_t> cumulative_solve_duration_ms_{0};

    mutable std::mutex trace_mutex_;
    std::string last_trace_id_;
};

} // namespace chronos
