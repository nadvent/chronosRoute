FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    libprotobuf-dev \
    protobuf-compiler \
    libgrpc++-dev \
    protobuf-compiler-grpc \
    libonnxruntime-dev \
    libgtest-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY CMakeLists.txt .
COPY proto/ ./proto/
COPY include/ ./include/
COPY src/ ./src/
COPY tests/ ./tests/
COPY models/ ./models/

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF && \
    cmake --build build -j$(nproc)

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgrpc++1.51t64 \
    libprotobuf32t64 \
    libonnxruntime-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/build/solver_node /app/solver_node
COPY models/ /app/models/

EXPOSE 50051

ENTRYPOINT ["/app/solver_node"]
