# ChronosRoute Architecture Decision Records (ADRs)

This directory documents the core systems architecture choices, concurrency invariants, and database tuning strategies underpinning the ChronosRoute polyglot engine.

| ADR | Title | Status | Primary Focus |
| :--- | :--- | :--- | :--- |
| [ADR 0001](0001-cpu-bound-vrp-offload-cpp20-grpc.md) | Offloading CPU-Bound VRP Metaheuristics to C++20 via gRPC | Accepted | Combinatorial search, zero GC jitter, SIMD/cache locality |
| [ADR 0002](0002-preventing-double-dispatch-skip-locked-idempotency.md) | Preventing Double-Dispatch Race Conditions with SELECT FOR UPDATE SKIP LOCKED | Accepted | Concurrency control, lock convoys, idempotency |
| [ADR 0003](0003-lock-free-double-buffering-traffic-graph.md) | Lock-Free Atomic Double Buffering vs. std::shared_mutex for Traffic Updates | Accepted | C++ memory ordering, reader-writer lock contention |
| [ADR 0004](0004-postgresql-partitioning-indexing-10m-telemetry.md) | PostgreSQL Index & Partition Tuning for 10M+ Geospatial Telemetry Rows | Accepted | PostGIS, BRIN indexing, declarative range partitioning |
