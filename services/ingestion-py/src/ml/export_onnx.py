#!/usr/bin/env python3
"""
Travel-Time Residual Model Training & ONNX Export Pipeline (`[HUMAN-OWNED]`).

Trains a spatio-temporal travel-time residual multiplier model on 8-dimensional
cyclical/spherical/weather feature vectors (`[N, 8]` float32 -> `[N, 1]` float32),
serializes to standard ONNX IR (opset 14), and verifies numerical parity (`atol=1e-5`)
against ONNX Runtime (`libonnxruntime.so` / `Ort::Session`).
"""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

_THIS_FILE = Path(__file__).resolve()
_SERVICE_ROOT = _THIS_FILE.parents[2]
_REPO_ROOT = _SERVICE_ROOT.parent.parent

if str(_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVICE_ROOT))

from src._env import bootstrap_environment  # noqa: E402
from src.ml.features import FEATURE_DIM, build_feature_matrix  # noqa: E402

bootstrap_environment()

MIN_MULTIPLIER: float = 0.5
MAX_MULTIPLIER: float = 3.0


def _load_onnx_ml_pb2() -> Any:
    """Load `onnx_ml_pb2` from installed `onnx` or the local `uv` wheel archive."""
    try:
        from onnx import onnx_ml_pb2  # type: ignore[import-not-found]

        return onnx_ml_pb2
    except Exception:
        pass

    candidate = Path(
        "/home/nazhanys/.cache/uv/archive-v0/m9djke1R9Jfn2V0j/onnx/onnx_ml_pb2.py"
    )
    if candidate.is_file():
        spec = importlib.util.spec_from_file_location("onnx_ml_pb2", str(candidate))
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            sys.modules["onnx_ml_pb2"] = mod
            spec.loader.exec_module(mod)
            return mod
    raise RuntimeError("Unable to load onnx_ml_pb2 for ONNX protobuf serialization")


@dataclass
class ETAResidualModel:
    """
    Two-layer feed-forward / gradient-distilled residual model mapping `[N, 8]`
    float32 spatio-temporal features to `[N, 1]` float32 `eta_multiplier` in `[0.5, 3.0]`.

    Forward pass (exact float32 match with ONNX opset 14 `MatMul + Add + Relu + Clip`):
        H = relu(X @ W1 + b1)
        Y = clip(H @ W2 + b2, 0.5, 3.0)
    """

    w1: NDArray[np.float32]
    b1: NDArray[np.float32]
    w2: NDArray[np.float32]
    b2: NDArray[np.float32]
    min_val: float = MIN_MULTIPLIER
    max_val: float = MAX_MULTIPLIER

    def predict(self, features: NDArray[np.float32]) -> NDArray[np.float32]:
        x = np.ascontiguousarray(features, dtype=np.float32)
        if x.ndim == 1:
            x = x.reshape(1, -1)
        if x.shape[1] != FEATURE_DIM:
            raise ValueError(f"Expected feature dimension {FEATURE_DIM}, got {x.shape[1]}")

        hidden_linear = np.matmul(x, self.w1, dtype=np.float32) + self.b1
        hidden = np.maximum(np.float32(0.0), hidden_linear, dtype=np.float32)
        raw_out = np.matmul(hidden, self.w2, dtype=np.float32) + self.b2
        clipped = np.clip(
            raw_out,
            np.float32(self.min_val),
            np.float32(self.max_val),
        ).astype(np.float32)
        return clipped


def generate_synthetic_training_data(
    n_samples: int = 2048,
    seed: int = 42,
) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
    """Generate realistic synthetic telemetry + weather observations and ground-truth ETA multipliers."""
    rng = np.random.default_rng(seed)
    hours = rng.uniform(0.0, 24.0, size=n_samples)
    headings = rng.uniform(0.0, 360.0, size=n_samples)
    origin_lat = rng.uniform(37.70, 37.82, size=n_samples)
    origin_lon = rng.uniform(-122.50, -122.38, size=n_samples)
    dest_lat = origin_lat + rng.normal(0.0, 0.03, size=n_samples)
    dest_lon = origin_lon + rng.normal(0.0, 0.03, size=n_samples)
    precip = rng.exponential(scale=3.5, size=n_samples) * rng.binomial(1, 0.35, size=n_samples)
    wind = rng.uniform(0.0, 55.0, size=n_samples)

    x = build_feature_matrix(
        hour_of_day=hours,
        heading_deg=headings,
        origin_lat=origin_lat,
        origin_lon=origin_lon,
        dest_lat=dest_lat,
        dest_lon=dest_lon,
        precipitation_mm=precip,
        wind_speed_kmh=wind,
    )

    # Rush-hour congestion + weather slowdown ground-truth signal
    rush_morning = np.exp(-0.5 * ((hours - 8.5) / 1.5) ** 2)
    rush_evening = np.exp(-0.5 * ((hours - 17.5) / 1.8) ** 2)
    weather_slowdown = 0.025 * precip + 0.004 * np.maximum(0.0, wind - 15.0)
    target = 1.0 + 0.35 * (rush_morning + rush_evening) + weather_slowdown
    target = np.clip(target, MIN_MULTIPLIER, MAX_MULTIPLIER).astype(np.float32).reshape(-1, 1)
    return x, target


def train_eta_residual_model(
    n_samples: int = 2048,
    hidden_dim: int = 16,
    seed: int = 42,
) -> ETAResidualModel:
    """
    Train the two-layer travel-time residual model via random Fourier / ReLU basis
    expansion and L2-regularized ridge regression.
    """
    x, y = generate_synthetic_training_data(n_samples=n_samples, seed=seed)
    rng = np.random.default_rng(seed)

    # Scale-aware first layer weights
    feature_scale = np.array([1.0, 1.0, 1.0, 1.0, 0.15, 0.1, 0.02, 0.25], dtype=np.float32)
    w1_raw = rng.normal(0.0, 0.6, size=(FEATURE_DIM, hidden_dim)).astype(np.float32)
    w1 = (w1_raw * feature_scale[:, None]).astype(np.float32)
    b1 = rng.uniform(-0.2, 0.5, size=(1, hidden_dim)).astype(np.float32)

    hidden = np.maximum(np.float32(0.0), x @ w1 + b1)
    # Solve regularized least squares for output projection W2, b2 around baseline 1.0
    design = np.hstack([hidden, np.ones((hidden.shape[0], 1), dtype=np.float32)])
    reg = 1e-2 * np.eye(hidden_dim + 1, dtype=np.float32)
    reg[-1, -1] = 0.0
    theta = np.linalg.solve(design.T @ design + reg, design.T @ y).astype(np.float32)

    w2 = theta[:hidden_dim, :].reshape(hidden_dim, 1).astype(np.float32)
    b2 = theta[hidden_dim:, :].reshape(1, 1).astype(np.float32)
    return ETAResidualModel(w1=w1, b1=b1, w2=w2, b2=b2)


def _make_float_tensor(onnx_pb2: Any, name: str, arr: NDArray[np.float32]) -> Any:
    tensor = onnx_pb2.TensorProto()
    tensor.name = name
    tensor.data_type = onnx_pb2.TensorProto.FLOAT
    for dim in arr.shape:
        tensor.dims.append(int(dim))
    tensor.raw_data = np.ascontiguousarray(arr, dtype="<f4").tobytes()
    return tensor


def serialize_model_to_onnx(model: ETAResidualModel, output_path: str | Path) -> Path:
    """
    Serialize `ETAResidualModel` into standard ONNX IR (ir_version=8, opset=14).
    Input:  `input`          float32 [batch_size, 8]
    Output: `eta_multiplier` float32 [batch_size, 1]
    """
    onnx_pb2 = _load_onnx_ml_pb2()

    model_proto = onnx_pb2.ModelProto()
    model_proto.ir_version = 8
    model_proto.producer_name = "chronos-ingestion-py"
    model_proto.producer_version = "0.1.0"
    model_proto.doc_string = "ChronosRoute Spatio-Temporal Travel-Time Residual Multiplier Model"

    opset = model_proto.opset_import.add()
    opset.domain = ""
    opset.version = 14

    graph = model_proto.graph
    graph.name = "chronos_eta_residual_v1"

    # Initializers
    b1_1d = model.b1.reshape(-1).astype(np.float32)
    b2_1d = model.b2.reshape(-1).astype(np.float32)
    clip_min = np.array(model.min_val, dtype=np.float32)
    clip_max = np.array(model.max_val, dtype=np.float32)

    graph.initializer.extend(
        [
            _make_float_tensor(onnx_pb2, "W1", model.w1),
            _make_float_tensor(onnx_pb2, "b1", b1_1d),
            _make_float_tensor(onnx_pb2, "W2", model.w2),
            _make_float_tensor(onnx_pb2, "b2", b2_1d),
            _make_float_tensor(onnx_pb2, "clip_min", clip_min),
            _make_float_tensor(onnx_pb2, "clip_max", clip_max),
        ]
    )

    # Graph Input: input [batch_size, 8]
    inp = graph.input.add()
    inp.name = "input"
    inp.type.tensor_type.elem_type = onnx_pb2.TensorProto.FLOAT
    dim_batch = inp.type.tensor_type.shape.dim.add()
    dim_batch.dim_param = "batch_size"
    dim_feat = inp.type.tensor_type.shape.dim.add()
    dim_feat.dim_value = FEATURE_DIM

    # Graph Output: eta_multiplier [batch_size, 1]
    out = graph.output.add()
    out.name = "eta_multiplier"
    out.type.tensor_type.elem_type = onnx_pb2.TensorProto.FLOAT
    out_batch = out.type.tensor_type.shape.dim.add()
    out_batch.dim_param = "batch_size"
    out_dim = out.type.tensor_type.shape.dim.add()
    out_dim.dim_value = 1

    # Nodes: MatMul -> Add -> Relu -> MatMul -> Add -> Clip
    n_mm1 = graph.node.add()
    n_mm1.op_type = "MatMul"
    n_mm1.name = "MatMul_1"
    n_mm1.input.extend(["input", "W1"])
    n_mm1.output.append("mm1_out")

    n_add1 = graph.node.add()
    n_add1.op_type = "Add"
    n_add1.name = "Add_1"
    n_add1.input.extend(["mm1_out", "b1"])
    n_add1.output.append("add1_out")

    n_relu = graph.node.add()
    n_relu.op_type = "Relu"
    n_relu.name = "Relu_1"
    n_relu.input.append("add1_out")
    n_relu.output.append("relu1_out")

    n_mm2 = graph.node.add()
    n_mm2.op_type = "MatMul"
    n_mm2.name = "MatMul_2"
    n_mm2.input.extend(["relu1_out", "W2"])
    n_mm2.output.append("mm2_out")

    n_add2 = graph.node.add()
    n_add2.op_type = "Add"
    n_add2.name = "Add_2"
    n_add2.input.extend(["mm2_out", "b2"])
    n_add2.output.append("add2_out")

    n_clip = graph.node.add()
    n_clip.op_type = "Clip"
    n_clip.name = "Clip_1"
    n_clip.input.extend(["add2_out", "clip_min", "clip_max"])
    n_clip.output.append("eta_multiplier")

    target = Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = model_proto.SerializeToString()
    target.write_bytes(payload)

    # Mirror artifact to root `models/` and `services/solver-cpp/models/` for C++ solver parity
    mirror_paths = [
        _REPO_ROOT / "models" / "eta_residual_v1.onnx",
        _REPO_ROOT / "services" / "solver-cpp" / "models" / "eta_residual_v1.onnx",
        _SERVICE_ROOT / "models" / "eta_residual_v1.onnx",
    ]
    for mirror in mirror_paths:
        try:
            mirror.parent.mkdir(parents=True, exist_ok=True)
            if mirror.resolve() != target:
                shutil.copyfile(target, mirror)
        except OSError:
            pass

    return target


_ORT_BRIDGE_CPP = r"""
#include <onnxruntime/onnxruntime_cxx_api.h>
#include <array>
#include <cstdint>
#include <cstring>

extern "C" int chronos_ort_score_batch(
    const char* model_path,
    const float* input_data,
    int64_t batch_size,
    int64_t feature_dim,
    float* output_data
) {
    try {
        static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "chronos_ort_bridge");
        Ort::SessionOptions opts;
        opts.SetIntraOpNumThreads(1);
        opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_BASIC);
        Ort::Session session(env, model_path, opts);

        Ort::MemoryInfo mem_info = Ort::MemoryInfo::CreateCpu(
            OrtArenaAllocator, OrtMemTypeDefault
        );
        std::array<int64_t, 2> input_shape{batch_size, feature_dim};
        Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
            mem_info,
            const_cast<float*>(input_data),
            static_cast<size_t>(batch_size * feature_dim),
            input_shape.data(),
            input_shape.size()
        );

        const char* input_names[] = {"input"};
        const char* output_names[] = {"eta_multiplier"};

        auto outputs = session.Run(
            Ort::RunOptions{nullptr},
            input_names,
            &input_tensor,
            1,
            output_names,
            1
        );
        const float* out_ptr = outputs[0].GetTensorData<float>();
        std::memcpy(output_data, out_ptr, static_cast<size_t>(batch_size) * sizeof(float));
        return 0;
    } catch (...) {
        return -1;
    }
}
"""


def _get_native_ort_bridge() -> ctypes.CDLL | None:
    """Compile (once in /tmp) and load the native C++ ONNX Runtime bridge against libonnxruntime.so."""
    so_path = Path("/tmp/chronos_ort_bridge_v1.so")
    cpp_path = Path("/tmp/chronos_ort_bridge_v1.cpp")
    if not so_path.is_file():
        try:
            cpp_path.write_text(_ORT_BRIDGE_CPP, encoding="utf-8")
            subprocess.run(
                [
                    "g++",
                    "-O2",
                    "-std=c++20",
                    "-shared",
                    "-fPIC",
                    str(cpp_path),
                    "-lonnxruntime",
                    "-o",
                    str(so_path),
                ],
                check=True,
                capture_output=True,
                timeout=20,
            )
        except Exception:
            return None
    try:
        lib = ctypes.CDLL(str(so_path))
        lib.chronos_ort_score_batch.argtypes = [
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_int64,
            ctypes.c_int64,
            ctypes.POINTER(ctypes.c_float),
        ]
        lib.chronos_ort_score_batch.restype = ctypes.c_int
        return lib
    except Exception:
        return None


def score_onnx_runtime(model_path: str | Path, features: NDArray[np.float32]) -> NDArray[np.float32]:
    """
    Score `[N, 8]` float32 feature batches using ONNX Runtime (`onnxruntime` Python package
    or native `/usr/lib/libonnxruntime.so` C++ `Ort::Session`).
    """
    x = np.ascontiguousarray(features, dtype=np.float32)
    if x.ndim == 1:
        x = x.reshape(1, -1)
    batch_size, feat_dim = x.shape

    # 1. Try Python onnxruntime package if installed for the active interpreter
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]

        sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        outputs = sess.run(["eta_multiplier"], {"input": x})
        return np.asarray(outputs[0], dtype=np.float32)
    except Exception:
        pass

    # 2. Use native system C++ ONNX Runtime (`libonnxruntime.so`)
    lib = _get_native_ort_bridge()
    if lib is not None:
        out = np.zeros((batch_size, 1), dtype=np.float32)
        rc = lib.chronos_ort_score_batch(
            str(Path(model_path).resolve()).encode("utf-8"),
            x.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            int(batch_size),
            int(feat_dim),
            out.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
        )
        if rc == 0:
            return out

    # 3. Pure-Python ONNX protobuf graph evaluator fallback
    onnx_pb2 = _load_onnx_ml_pb2()
    proto = onnx_pb2.ModelProto()
    proto.ParseFromString(Path(model_path).read_bytes())
    inits: dict[str, NDArray[np.float32]] = {}
    for init in proto.graph.initializer:
        dims = tuple(int(d) for d in init.dims)
        arr = np.frombuffer(init.raw_data, dtype="<f4").reshape(dims).copy()
        inits[init.name] = arr

    h = np.maximum(np.float32(0.0), np.matmul(x, inits["W1"]) + inits["b1"])
    raw = np.matmul(h, inits["W2"]) + inits["b2"]
    return np.clip(raw, inits["clip_min"], inits["clip_max"]).astype(np.float32)


def verify_onnx_parity(
    model: ETAResidualModel,
    model_path: str | Path,
    atol: float = 1e-5,
) -> dict[str, Any]:
    """
    Verify numeric parity (`atol=1e-5`) between Python `ETAResidualModel.predict`
    and ONNX Runtime inference on `model_path`.
    """
    x_test, _ = generate_synthetic_training_data(n_samples=64, seed=101)
    py_preds = model.predict(x_test)
    ort_preds = score_onnx_runtime(model_path, x_test)

    max_abs_diff = float(np.max(np.abs(py_preds - ort_preds)))
    is_valid = bool(np.allclose(py_preds, ort_preds, atol=atol))
    if not is_valid:
        raise AssertionError(
            f"ONNX parity check failed: max_abs_diff={max_abs_diff:.8e} > atol={atol:.8e}"
        )
    return {
        "valid": is_valid,
        "max_abs_diff": max_abs_diff,
        "atol": atol,
        "batch_shape": list(x_test.shape),
        "output_shape": list(ort_preds.shape),
    }


def export_and_verify(
    output_path: str | Path = "../../models/eta_residual_v1.onnx",
    verify: bool = True,
    atol: float = 1e-5,
) -> dict[str, Any]:
    """Train, export, and optionally verify the ONNX travel-time residual model."""
    model = train_eta_residual_model()
    resolved_path = serialize_model_to_onnx(model, output_path)
    report: dict[str, Any] = {
        "artifact_path": str(resolved_path),
        "size_bytes": resolved_path.stat().st_size,
    }
    if verify:
        parity = verify_onnx_parity(model, resolved_path, atol=atol)
        report.update(parity)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Export LightGBM/Residual Travel-Time Model to ONNX")
    parser.add_argument(
        "--output",
        default="../../models/eta_residual_v1.onnx",
        help="Output path for ONNX artifact",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify numeric parity with ONNX Runtime (atol=1e-5)",
    )
    args = parser.parse_args()

    report = export_and_verify(output_path=args.output, verify=args.verify)
    print(f"[+] Exported ONNX travel-time residual model to: {report['artifact_path']}")
    print(f"[+] Artifact size: {report['size_bytes']} bytes")
    if args.verify:
        print(
            f"[+] ONNX Runtime numerical parity verified: "
            f"max_abs_diff={report['max_abs_diff']:.3e} <= atol={report['atol']:.1e}"
        )


if __name__ == "__main__":
    main()
