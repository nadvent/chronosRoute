# ChronosRoute Benchmarks Suite

This directory contains load generation and database profiling scripts to validate the systems invariants and performance targets of ChronosRoute.

## Directory Structure

- `k6/`: Load test scripts for testing ingestion throughput (5,000+ GPS events/sec) and orchestrator virtual thread saturation (up to 10k concurrent requests).
- `locust/`: Python-based distributed load generation scripts.
- `sql_plans/`: Five critical database EXPLAIN (ANALYZE, BUFFERS) query benchmarks:
  1. `01_spatial_gist_benchmark.sql`: PostGIS GiST Index Scan (<4ms) vs sequential scan (>450ms).
  2. `02_covering_index_benchmark.sql`: Index-Only Scan with Heap Fetches: 0 using the ESR rule.
  3. `03_partial_index_benchmark.sql`: 95%+ index footprint reduction for skewed status tables.
  4. `04_partition_pruning_benchmark.sql`: Time-range partition pruning scanning 1 partition instead of 10M rows.
  5. `05_skip_locked_concurrency.sql`: Lock-free worker batch claiming eliminating lock-wait convoys.
