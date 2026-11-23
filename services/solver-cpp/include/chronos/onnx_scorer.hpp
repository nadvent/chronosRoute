#pragma once

// ============================================================================
// [CO-AUTHORED] Module CPP-5b: ONNX Runtime C++ RAII Wrapper &
// Zero-Copy Batch Edge Multiplier Scoring
// ============================================================================

#include <onnxruntime_cxx_api.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace chronos {

inline constexpr size_t kDefaultEdgeFeatureDim = 8;

struct EdgeFeatureVector {
    float hour_sin{0.0f};
    float hour_cos{1.0f};
    float heading_sin{0.0f};
    float heading_cos{1.0f};
    float distance_km{1.0f};
    float precipitation_mm{0.0f};
    float wind_speed_kmh{0.0f};
    float congestion_index{0.0f};

    [[nodiscard]] std::array<float, kDefaultEdgeFeatureDim> to_array() const noexcept {
        return {hour_sin,         hour_cos,       heading_sin,      heading_cos,
                distance_km,      precipitation_mm, wind_speed_kmh, congestion_index};
    }
};

class OnnxEdgeScorer {
public:
    // Initializes ONNX Runtime environment and loads the session if model_path exists.
    // Gracefully degrades to deterministic physics-informed fallback if model_path is
    // empty or absent on disk.
    explicit OnnxEdgeScorer(const std::string& model_path = "");

    // Construct directly from serialized in-memory ONNX model bytes
    explicit OnnxEdgeScorer(std::span<const uint8_t> model_bytes);

    ~OnnxEdgeScorer() noexcept = default;

    OnnxEdgeScorer(const OnnxEdgeScorer&) = delete;
    OnnxEdgeScorer& operator=(const OnnxEdgeScorer&) = delete;
    OnnxEdgeScorer(OnnxEdgeScorer&&) noexcept = default;
    OnnxEdgeScorer& operator=(OnnxEdgeScorer&&) noexcept = default;

    [[nodiscard]] bool has_active_session() const noexcept { return session_ != nullptr; }
    [[nodiscard]] const std::string& model_path() const noexcept { return model_path_; }

    // Batch-score [batch_size, feature_dim] contiguous float32 features into
    // speed multipliers in [0.05, 2.0] using zero-copy Ort::Value::CreateTensor<float>.
    [[nodiscard]] std::vector<float> score_batch_flat(
        std::span<const float> features,
        size_t batch_size,
        size_t feature_dim = kDefaultEdgeFeatureDim) const;

    [[nodiscard]] std::vector<float> score_batch(
        std::span<const EdgeFeatureVector> edge_features) const;

    // Deterministic fallback formula used when an ONNX model file is not present
    [[nodiscard]] static float fallback_score_row(
        std::span<const float> row_features) noexcept;

private:
    void init_session_metadata();

    std::string model_path_;
    Ort::Env env_;
    Ort::SessionOptions session_options_;
    Ort::MemoryInfo memory_info_;
    std::unique_ptr<Ort::Session> session_;

    std::string input_name_{"input"};
    std::string output_name_{"eta_multiplier"};
};

} // namespace chronos
