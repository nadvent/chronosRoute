#pragma once

// ============================================================================
// [CO-AUTHORED] Module CPP-3: Work-Stealing std::jthread Pool &
// alignas(64) False-Sharing Prevention
// ============================================================================

#include "chronos/chronos.hpp"

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <stdexcept>
#include <stop_token>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

namespace chronos {

// Padded to 64-byte cache line boundaries so adjacent workers in
// std::vector<WorkerState> never invalidate each other's L1 cache lines
// during tight ALNS PRNG generation and counter updates.
struct alignas(64) WorkerState {
    std::mt19937_64 prng{0xC40505ULL};
    uint64_t tasks_executed{0};
    uint64_t tasks_stolen{0};
    uint64_t iterations_completed{0};
    uint32_t worker_id{0};

    explicit WorkerState(uint32_t id = 0, uint64_t seed = 0x9E3779B97F4A7C15ULL) noexcept
        : prng(seed ^ (static_cast<uint64_t>(id + 1U) * 0xBF58476D1CE4E5B9ULL)),
          tasks_executed(0),
          tasks_stolen(0),
          iterations_completed(0),
          worker_id(id) {}
};

static_assert(alignof(WorkerState) == 64,
              "WorkerState must be 64-byte cache-line aligned to prevent false sharing");
static_assert(sizeof(WorkerState) % 64 == 0,
              "sizeof(WorkerState) must be a multiple of 64 bytes in contiguous arrays");

class ThreadPool {
public:
    using Task = std::function<void(uint32_t worker_id, std::stop_token stop_token)>;

    explicit ThreadPool(uint32_t num_workers = kDefaultWorkerThreads,
                        size_t max_queue_capacity_per_worker = kDefaultMaxQueueCapacityPerWorker);

    ~ThreadPool() noexcept;

    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;
    ThreadPool(ThreadPool&&) = delete;
    ThreadPool& operator=(ThreadPool&&) = delete;

    // Non-blocking submission with bounded queue backpressure.
    // Returns false if all worker queues are at max_queue_capacity_per_worker
    // or if shutdown has been requested.
    [[nodiscard]] bool try_submit(Task task);

    // Blocking submission that applies backpressure if the target worker queue is full.
    // Returns false only if the pool is shutting down.
    bool submit_task(Task task);

    // Submit a callable returning F(worker_id, stop_token) or F() and obtain a std::future.
    template <typename F>
    auto submit(F&& func) -> std::future<
        std::invoke_result_t<std::decay_t<F>, uint32_t, std::stop_token>> {
        using ReturnType = std::invoke_result_t<std::decay_t<F>, uint32_t, std::stop_token>;
        auto promise = std::make_shared<std::promise<ReturnType>>();
        std::future<ReturnType> fut = promise->get_future();

        bool accepted = submit_task(
            [prom = std::move(promise), fn = std::forward<F>(func)](
                uint32_t worker_id, std::stop_token stop_token) mutable {
                try {
                    if constexpr (std::is_void_v<ReturnType>) {
                        fn(worker_id, stop_token);
                        prom->set_value();
                    } else {
                        prom->set_value(fn(worker_id, stop_token));
                    }
                } catch (...) {
                    prom->set_exception(std::current_exception());
                }
            });

        if (!accepted) {
            throw std::runtime_error("ThreadPool is stopped; cannot submit task");
        }
        return fut;
    }

    // Request cooperative stop across all jthread workers and wake blocked queues.
    void request_stop() noexcept;

    [[nodiscard]] uint32_t num_workers() const noexcept { return num_workers_; }
    [[nodiscard]] size_t max_queue_capacity_per_worker() const noexcept {
        return max_queue_capacity_;
    }
    [[nodiscard]] uint32_t active_tasks() const noexcept {
        return active_tasks_.load(std::memory_order_relaxed);
    }

    // Read-only access to cache-line-aligned per-worker state array
    [[nodiscard]] WorkerState& worker_state(uint32_t worker_id) noexcept {
        return worker_states_[worker_id];
    }
    [[nodiscard]] const WorkerState& worker_state(uint32_t worker_id) const noexcept {
        return worker_states_[worker_id];
    }
    [[nodiscard]] const std::vector<WorkerState>& worker_states() const noexcept {
        return worker_states_;
    }

private:
    struct alignas(64) WorkerQueue {
        std::mutex mtx;
        std::condition_variable not_full_cv;
        std::deque<Task> deque;
    };

    void worker_loop(uint32_t worker_id, std::stop_token stop_token);
    std::optional<Task> pop_local_or_steal(uint32_t worker_id);
    bool has_any_pending_tasks() const noexcept;

    uint32_t num_workers_{1};
    size_t max_queue_capacity_{kDefaultMaxQueueCapacityPerWorker};
    std::atomic<uint64_t> next_queue_idx_{0};
    std::atomic<uint32_t> active_tasks_{0};
    std::atomic<uint64_t> pending_tasks_{0};
    std::atomic<bool> stopping_{false};

    std::vector<WorkerState> worker_states_;
    std::vector<std::unique_ptr<WorkerQueue>> queues_;

    mutable std::mutex wake_mutex_;
    std::condition_variable wake_cv_;

    // Declared last so jthreads join/destroy before queues_ and worker_states_
    std::vector<std::jthread> threads_;
};

} // namespace chronos
