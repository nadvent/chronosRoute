#include "chronos/onnx_scorer.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>

namespace chronos {

OnnxEdgeScorer::OnnxEdgeScorer(const std::string& model_path)
    : model_path_(model_path),
      env_(ORT_LOGGING_LEVEL_WARNING, "ChronosSolverOnnx"),
      session_options_(),
      memory_info_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
    session_options_.SetIntraOpNumThreads(1);
    session_options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_BASIC);

    if (model_path_.empty()) {
        for (const char* candidate : {
                 "models/eta_residual_v1.onnx",
                 "../models/eta_residual_v1.onnx",
                 "../../models/eta_residual_v1.onnx",
                 "services/solver-cpp/models/eta_residual_v1.onnx",
             }) {
            if (std::filesystem::exists(candidate)) {
                model_path_ = candidate;
                break;
            }
        }
    }

    if (!model_path_.empty() && std::filesystem::exists(model_path_)) {
        try {
            session_ = std::make_unique<Ort::Session>(env_, model_path_.c_str(), session_options_);
            init_session_metadata();
        } catch (const Ort::Exception&) {
            session_.reset();
        }
    }
}

OnnxEdgeScorer::OnnxEdgeScorer(std::span<const uint8_t> model_bytes)
    : model_path_("<in-memory-onnx>"),
      env_(ORT_LOGGING_LEVEL_WARNING, "ChronosSolverOnnx"),
      session_options_(),
      memory_info_(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
    session_options_.SetIntraOpNumThreads(1);
    session_options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_BASIC);

    if (!model_bytes.empty()) {
        try {
            session_ = std::make_unique<Ort::Session>(
                env_, model_bytes.data(), model_bytes.size(), session_options_);
            init_session_metadata();
        } catch (const Ort::Exception&) {
            session_.reset();
        }
    }
}

void OnnxEdgeScorer::init_session_metadata() {
    if (!session_) return;
    Ort::AllocatorWithDefaultOptions allocator;
    if (session_->GetInputCount() > 0U) {
        auto in_name = session_->GetInputNameAllocated(0, allocator);
        if (in_name) {
            input_name_ = in_name.get();
        }
    }
    if (session_->GetOutputCount() > 0U) {
        auto out_name = session_->GetOutputNameAllocated(0, allocator);
        if (out_name) {
            output_name_ = out_name.get();
        }
    }
}

float OnnxEdgeScorer::fallback_score_row(std::span<const float> row_features) noexcept {
    // Deterministic physics-informed residual speed multiplier in [0.15, 1.25]
    // Feature layout:
    // [0]=hour_sin, [1]=hour_cos, [2]=heading_sin, [3]=heading_cos,
    // [4]=distance_km, [5]=precipitation_mm, [6]=wind_speed_kmh, [7]=congestion_index
    const float hour_cos = row_features.size() > 1U ? row_features[1] : 0.0f;
    const float precip_mm = row_features.size() > 5U ? std::max(0.0f, row_features[5]) : 0.0f;
    const float wind_kmh = row_features.size() > 6U ? std::max(0.0f, row_features[6]) : 0.0f;
    const float congestion = row_features.size() > 7U
                                 ? std::clamp(row_features[7], 0.0f, 1.0f)
                                 : 0.0f;

    float mult = 1.0f;
    mult -= 0.012f * precip_mm;
    mult -= 0.0025f * wind_kmh;
    mult -= 0.35f * congestion;
    mult += 0.04f * hour_cos; // Nighttime free-flow boost when hour_cos > 0
    return std::clamp(mult, 0.15f, 1.25f);
}

std::vector<float> OnnxEdgeScorer::score_batch_flat(
    std::span<const float> features,
    size_t batch_size,
    size_t feature_dim) const {
    if (batch_size == 0U || feature_dim == 0U ||
        features.size() < batch_size * feature_dim) {
        return {};
    }

    std::vector<float> output(batch_size, 1.0f);

    if (session_) {
        try {
            const std::array<int64_t, 2> input_shape = {
                static_cast<int64_t>(batch_size),
                static_cast<int64_t>(feature_dim),
            };

            // Zero-copy input tensor binding directly over caller's contiguous buffer
            Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
                memory_info_,
                const_cast<float*>(features.data()),
                batch_size * feature_dim,
                input_shape.data(),
                input_shape.size());

            const char* input_names[] = {input_name_.c_str()};
            const char* output_names[] = {output_name_.c_str()};

            auto output_tensors = session_->Run(
                Ort::RunOptions{nullptr},
                input_names,
                &input_tensor,
                1U,
                output_names,
                1U);

            if (!output_tensors.empty() && output_tensors[0].IsTensor()) {
                const float* raw_out = output_tensors[0].GetTensorData<float>();
                const auto type_info = output_tensors[0].GetTensorTypeAndShapeInfo();
                const size_t count = std::min(batch_size, type_info.GetElementCount());
                for (size_t i = 0; i < count; ++i) {
                    const float val = std::isfinite(raw_out[i]) ? raw_out[i] : 1.0f;
                    // Support both direct speed multipliers and ETA multipliers
                    output[i] = std::clamp(val, 0.05f, 2.0f);
                }
                return output;
            }
        } catch (const Ort::Exception&) {
            // Fall through to deterministic fallback on shape/runtime mismatch
        }
    }

    for (size_t i = 0; i < batch_size; ++i) {
        output[i] = fallback_score_row(features.subspan(i * feature_dim, feature_dim));
    }
    return output;
}

std::vector<float> OnnxEdgeScorer::score_batch(
    std::span<const EdgeFeatureVector> edge_features) const {
    if (edge_features.empty()) return {};
    std::vector<float> flat;
    flat.reserve(edge_features.size() * kDefaultEdgeFeatureDim);
    for (const auto& ef : edge_features) {
        const auto arr = ef.to_array();
        flat.insert(flat.end(), arr.begin(), arr.end());
    }
    return score_batch_flat(flat, edge_features.size(), kDefaultEdgeFeatureDim);
}

} // namespace chronos
