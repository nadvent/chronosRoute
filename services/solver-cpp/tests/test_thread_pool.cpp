#include "chronos/thread_pool.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <future>
#include <latch>
#include <thread>
#include <vector>

namespace chronos {
namespace {

static_assert(alignof(WorkerState) == 64,
              "WorkerState must satisfy 64-byte cache line alignment");
static_assert(sizeof(WorkerState) % 64 == 0,
              "WorkerState size must be a multiple of 64 bytes");

TEST(ThreadPoolTest, WorkerStateCacheLineAlignmentAndNoFalseSharing) {
    ThreadPool pool(4, 32);
    ASSERT_EQ(pool.worker_states().size(), 4U);

    for (uint32_t i = 0; i < pool.num_workers(); ++i) {
        const auto addr = reinterpret_cast<std::uintptr_t>(&pool.worker_state(i));
        EXPECT_EQ(addr % 64U, 0U) << "WorkerState[" << i << "] not 64-byte aligned";
        if (i + 1U < pool.num_workers()) {
            const auto next_addr = reinterpret_cast<std::uintptr_t>(&pool.worker_state(i + 1U));
            EXPECT_GE(next_addr - addr, 64U);
        }
    }
}

TEST(ThreadPoolTest, WorkStealingExecutionAcrossCores) {
    ThreadPool pool(4, 256);
    constexpr int kNumTasks = 200;

    std::vector<std::future<int>> futures;
    futures.reserve(kNumTasks);

    for (int i = 0; i < kNumTasks; ++i) {
        futures.push_back(pool.submit(
            [i, &pool](uint32_t worker_id, std::stop_token /*st*/) -> int {
                // Exercise per-worker cache-aligned PRNG
                auto& ws = pool.worker_state(worker_id);
                const uint64_t r = ws.prng();
                (void)r;
                return i * i;
            }));
    }

    int sum = 0;
    for (int i = 0; i < kNumTasks; ++i) {
        const int val = futures[static_cast<size_t>(i)].get();
        EXPECT_EQ(val, i * i);
        sum += val;
    }
    EXPECT_GT(sum, 0);

    uint64_t total_executed = 0;
    for (uint32_t w = 0; w < pool.num_workers(); ++w) {
        total_executed += pool.worker_state(w).tasks_executed;
    }
    EXPECT_EQ(total_executed, static_cast<uint64_t>(kNumTasks));
}

TEST(ThreadPoolTest, BoundedQueueBackpressureRejectsOverflowOnTrySubmit) {
    // 2 workers, max 4 queued tasks per worker = 8 queued tasks capacity
    ThreadPool pool(2, 4);

    std::latch workers_busy(2);
    std::latch release_workers(1);

    // Occupy both worker threads
    for (int i = 0; i < 2; ++i) {
        ASSERT_TRUE(pool.try_submit([&](uint32_t /*id*/, std::stop_token /*st*/) {
            workers_busy.count_down();
            release_workers.wait();
        }));
    }

    workers_busy.wait();

    // Fill all 2 * 4 = 8 bounded queue slots
    for (int i = 0; i < 8; ++i) {
        EXPECT_TRUE(pool.try_submit([](uint32_t /*id*/, std::stop_token /*st*/) {}))
            << "Slot " << i << " should fit in bounded queue";
    }

    // 9th queued task must be rejected immediately by bounded backpressure
    EXPECT_FALSE(pool.try_submit([](uint32_t /*id*/, std::stop_token /*st*/) {}));

    // Unblock workers and ensure pool drains cleanly
    release_workers.count_down();
    auto final_fut = pool.submit([](uint32_t /*id*/, std::stop_token /*st*/) { return 42; });
    EXPECT_EQ(final_fut.get(), 42);
}

TEST(ThreadPoolTest, CooperativeStopTokenCancellationUnderTSan) {
    ThreadPool pool(4, 64);
    std::atomic<int> cancelled_observed{0};
    std::latch started(4);

    std::vector<std::future<void>> futures;
    for (int i = 0; i < 4; ++i) {
        futures.push_back(pool.submit([&](uint32_t /*id*/, std::stop_token st) {
            started.count_down();
            while (!st.stop_requested()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            cancelled_observed.fetch_add(1, std::memory_order_relaxed);
        }));
    }

    started.wait();
    pool.request_stop();

    for (auto& f : futures) {
        f.get();
    }
    EXPECT_EQ(cancelled_observed.load(), 4);
}

} // namespace
} // namespace chronos
