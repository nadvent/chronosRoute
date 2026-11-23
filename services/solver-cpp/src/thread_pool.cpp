#include "chronos/thread_pool.hpp"

#include <algorithm>

namespace chronos {

ThreadPool::ThreadPool(uint32_t num_workers, size_t max_queue_capacity_per_worker)
    : num_workers_(std::max<uint32_t>(1U, num_workers)),
      max_queue_capacity_(std::max<size_t>(1U, max_queue_capacity_per_worker)) {
    worker_states_.reserve(num_workers_);
    queues_.reserve(num_workers_);

    for (uint32_t i = 0; i < num_workers_; ++i) {
        worker_states_.emplace_back(i);
        queues_.push_back(std::make_unique<WorkerQueue>());
    }

    threads_.reserve(num_workers_);
    for (uint32_t i = 0; i < num_workers_; ++i) {
        threads_.emplace_back([this, i](std::stop_token st) {
            worker_loop(i, std::move(st));
        });
    }
}

ThreadPool::~ThreadPool() noexcept {
    request_stop();
    for (auto& t : threads_) {
        if (t.joinable()) {
            t.join();
        }
    }
}

void ThreadPool::request_stop() noexcept {
    stopping_.store(true, std::memory_order_release);
    for (auto& t : threads_) {
        t.request_stop();
    }
    for (auto& q : queues_) {
        std::lock_guard<std::mutex> qlock(q->mtx);
        q->not_full_cv.notify_all();
    }
    {
        std::lock_guard<std::mutex> wlock(wake_mutex_);
        wake_cv_.notify_all();
    }
}

bool ThreadPool::try_submit(Task task) {
    if (stopping_.load(std::memory_order_acquire)) {
        return false;
    }

    const uint64_t start = next_queue_idx_.fetch_add(1U, std::memory_order_relaxed);
    for (uint32_t offset = 0; offset < num_workers_; ++offset) {
        const uint32_t q_idx =
            static_cast<uint32_t>((start + static_cast<uint64_t>(offset)) % num_workers_);
        auto& q = *queues_[q_idx];
        std::unique_lock<std::mutex> lock(q.mtx);
        if (stopping_.load(std::memory_order_acquire)) {
            return false;
        }
        if (q.deque.size() < max_queue_capacity_) {
            q.deque.push_back(std::move(task));
            pending_tasks_.fetch_add(1U, std::memory_order_release);
            lock.unlock();
            {
                std::lock_guard<std::mutex> wlock(wake_mutex_);
                wake_cv_.notify_one();
            }
            return true;
        }
    }
    return false;
}

bool ThreadPool::submit_task(Task task) {
    if (stopping_.load(std::memory_order_acquire)) {
        return false;
    }

    // First try non-blocking placement across all queues
    const uint64_t start = next_queue_idx_.fetch_add(1U, std::memory_order_relaxed);
    for (uint32_t offset = 0; offset < num_workers_; ++offset) {
        const uint32_t q_idx =
            static_cast<uint32_t>((start + static_cast<uint64_t>(offset)) % num_workers_);
        auto& q = *queues_[q_idx];
        std::unique_lock<std::mutex> lock(q.mtx);
        if (stopping_.load(std::memory_order_acquire)) {
            return false;
        }
        if (q.deque.size() < max_queue_capacity_) {
            q.deque.push_back(std::move(task));
            pending_tasks_.fetch_add(1U, std::memory_order_release);
            lock.unlock();
            {
                std::lock_guard<std::mutex> wlock(wake_mutex_);
                wake_cv_.notify_one();
            }
            return true;
        }
    }

    // All queues full: apply bounded backpressure on the assigned queue
    const uint32_t target_idx = static_cast<uint32_t>(start % num_workers_);
    auto& target_q = *queues_[target_idx];
    std::unique_lock<std::mutex> lock(target_q.mtx);
    target_q.not_full_cv.wait(lock, [this, &target_q]() {
        return stopping_.load(std::memory_order_acquire) ||
               target_q.deque.size() < max_queue_capacity_;
    });

    if (stopping_.load(std::memory_order_acquire)) {
        return false;
    }

    target_q.deque.push_back(std::move(task));
    pending_tasks_.fetch_add(1U, std::memory_order_release);
    lock.unlock();
    {
        std::lock_guard<std::mutex> wlock(wake_mutex_);
        wake_cv_.notify_one();
    }
    return true;
}

std::optional<ThreadPool::Task> ThreadPool::pop_local_or_steal(uint32_t worker_id) {
    // 1. Pop LIFO from own local queue for L1/L2 cache warmth
    {
        auto& local_q = *queues_[worker_id];
        std::unique_lock<std::mutex> lock(local_q.mtx);
        if (!local_q.deque.empty()) {
            Task task = std::move(local_q.deque.back());
            local_q.deque.pop_back();
            pending_tasks_.fetch_sub(1U, std::memory_order_release);
            local_q.not_full_cv.notify_one();
            lock.unlock();
            ++worker_states_[worker_id].tasks_executed;
            return task;
        }
    }

    // 2. Steal FIFO from peer queues
    for (uint32_t offset = 1; offset < num_workers_; ++offset) {
        const uint32_t victim_id = (worker_id + offset) % num_workers_;
        auto& victim_q = *queues_[victim_id];
        std::unique_lock<std::mutex> lock(victim_q.mtx, std::try_to_lock);
        if (lock.owns_lock() && !victim_q.deque.empty()) {
            Task stolen = std::move(victim_q.deque.front());
            victim_q.deque.pop_front();
            pending_tasks_.fetch_sub(1U, std::memory_order_release);
            victim_q.not_full_cv.notify_one();
            lock.unlock();
            ++worker_states_[worker_id].tasks_stolen;
            ++worker_states_[worker_id].tasks_executed;
            return stolen;
        }
    }

    // Second pass with blocking lock if pending_tasks_ > 0
    if (pending_tasks_.load(std::memory_order_acquire) > 0U) {
        for (uint32_t offset = 1; offset < num_workers_; ++offset) {
            const uint32_t victim_id = (worker_id + offset) % num_workers_;
            auto& victim_q = *queues_[victim_id];
            std::unique_lock<std::mutex> lock(victim_q.mtx);
            if (!victim_q.deque.empty()) {
                Task stolen = std::move(victim_q.deque.front());
                victim_q.deque.pop_front();
                pending_tasks_.fetch_sub(1U, std::memory_order_release);
                victim_q.not_full_cv.notify_one();
                lock.unlock();
                ++worker_states_[worker_id].tasks_stolen;
                ++worker_states_[worker_id].tasks_executed;
                return stolen;
            }
        }
    }

    return std::nullopt;
}

void ThreadPool::worker_loop(uint32_t worker_id, std::stop_token stop_token) {
    std::stop_callback wake_on_stop(stop_token, [this]() {
        std::lock_guard<std::mutex> wlock(wake_mutex_);
        wake_cv_.notify_all();
    });

    while (true) {
        if (auto maybe_task = pop_local_or_steal(worker_id); maybe_task.has_value()) {
            active_tasks_.fetch_add(1U, std::memory_order_relaxed);
            (*maybe_task)(worker_id, stop_token);
            active_tasks_.fetch_sub(1U, std::memory_order_relaxed);
            continue;
        }

        std::unique_lock<std::mutex> wlock(wake_mutex_);
        wake_cv_.wait(wlock, [this, &stop_token]() {
            return pending_tasks_.load(std::memory_order_acquire) > 0U ||
                   stop_token.stop_requested() ||
                   stopping_.load(std::memory_order_acquire);
        });

        if ((stop_token.stop_requested() || stopping_.load(std::memory_order_acquire)) &&
            pending_tasks_.load(std::memory_order_acquire) == 0U) {
            break;
        }
    }
}

} // namespace chronos
