#pragma once

#include <cstdint>
#include <string_view>

namespace chronos {

inline constexpr std::string_view kEngineVersion = "0.2.0";
inline constexpr int kDefaultPort = 50051;
inline constexpr uint32_t kDefaultWorkerThreads = 8;
inline constexpr size_t kDefaultMaxQueueCapacityPerWorker = 1024;
inline constexpr int64_t kDefaultSolverDeadlineMs = 500;
inline constexpr std::string_view kTraceIdHeader = "x-trace-id";

} // namespace chronos
