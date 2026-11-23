# ADR 0001: Offloading CPU-Bound VRP Metaheuristics to C++20 via gRPC

## Status
Accepted

## Context
The Capacitated Vehicle Routing Problem with Time Windows (CVRPTW) is NP-hard. Evaluating candidate moves in local search (2-opt, Or-opt, relocate, exchange) requires billions of operations per second across large road networks. 
We evaluated three candidate architectures:
1. Running ALNS inside Python 3.12 (using PyPy, Numba, or C-extensions)
2. Running ALNS inside Java 21 (using Virtual Threads or ForkJoinPool)
3. Offloading ALNS to a standalone C++20 microservice communicating over HTTP/2 gRPC with Protocol Buffers

## Decision
We offload all road graph preprocessing (Contraction Hierarchies / Landmark A*) and combinatorial search (multithreaded ALNS) to a dedicated C++20 service (`solver-cpp`) invoked via gRPC by the Java orchestrator.

## Rationale
- **Zero GC Pause Jitter:** Garbage collection pauses in Java (even with ZGC) and Python GIL contention introduce unacceptable tail latency (p99 > 2 seconds) when managing tens of millions of candidate route permutations in memory.
- **Cache-Line & SIMD Control:** C++20 provides deterministic memory layouts (`std::vector` contiguous arrays for Compressed Sparse Row road graphs) and cache-line alignment (`alignas(64)`), eliminating L1/L2 cache invalidations and false sharing across worker cores.
- **Resource Isolation:** Memory-intensive, CPU-saturating combinatorial search is decoupled from transactional state transitions and I/O-bound webhooks, preventing CPU starvation on the Spring Boot dispatch orchestrator.
- **Predictable Sub-500ms Deadlines:** gRPC client context deadlines (`withDeadlineAfter(500, TimeUnit.MILLISECONDS)`) enforce hard computational limits, returning the best feasible solution found within budget.

## Consequences
- Requires Protobuf contract maintenance (`proto/routing_service.proto`) and cross-language stub compilation.
- Introduces network serialization overhead (< 2 ms over local IPC/loopback gRPC).
