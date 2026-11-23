# ChronosRoute Protocol Buffers & gRPC Contracts

This directory contains the central interface definition (`routing_service.proto`) shared across all three programming languages in the ChronosRoute polyglot monorepo:

- **Java 21 Orchestrator** (`services/orchestrator-java`): Calls the solver over gRPC with strict deadline propagation (`withDeadlineAfter(500, TimeUnit.MILLISECONDS)`).
- **C++20 Compute Engine** (`services/solver-cpp`): Implements high-performance combinatorial search (ALNS CVRPTW) and Landmark A* / Contraction Hierarchies.
- **Python 3.12 Gateway** (`services/ingestion-py`): Can query distance matrices and trigger dynamic graph weight re-calibrations based on real-time weather and traffic.

## Schema Highlights

- `SolveCVRPTW`: Transmits vehicles, stops (with delivery time windows, priority, and pickup-before-dropoff precedence), constraints, and returns optimized route sequences with sub-millisecond execution metrics.
- `UpdateTrafficMultipliers`: Streams batch speed multipliers from Open-Meteo weather data and real-time GPS pings into the C++ CSR graph double-buffer.
- `ComputeDistanceMatrix`: Fast asymmetric $N \times N$ duration/distance evaluation.
- `CheckHealth`: High-resolution telemetry on worker thread pool saturation and graph statistics.

## Stub Generation Commands

### C++20 Stubs
```bash
protoc -I=. --cpp_out=../services/solver-cpp/src/proto --grpc_out=../services/solver-cpp/src/proto --plugin=protoc-gen-grpc=$(which grpc_cpp_plugin) routing_service.proto
```

### Java 21 Stubs
Integrated directly via the `protobuf-maven-plugin` in `services/orchestrator-java/pom.xml`:
```bash
mvn compile
```

### Python 3.12 Stubs
```bash
python -m grpc_tools.protoc -I. --python_out=../services/ingestion-py/generated --grpc_python_out=../services/ingestion-py/generated routing_service.proto
```
