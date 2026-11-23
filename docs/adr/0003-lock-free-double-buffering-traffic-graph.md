# ADR 0003: Lock-Free Atomic Double Buffering vs. std::shared_mutex for Live Traffic Graph Updates

## Status
Accepted

## Context
The C++ solver engine evaluates millions of edge travel times per second across 8–16 worker threads while background threads periodically stream live weather multipliers (from Open-Meteo) and traffic congestion updates.
We considered two synchronization primitives to protect the road graph dynamic weight array:
1. Reader-Writer Lock (`std::shared_mutex` with `std::shared_lock` on reads and `std::unique_lock` on updates)
2. Lock-free Atomic Double Buffering (`std::atomic<std::shared_ptr<const EdgeWeightSnapshot>>`)

## Decision
We implement atomic double buffering (`std::atomic<std::shared_ptr<const EdgeWeightSnapshot>>`) with `std::memory_order_acquire` / `std::memory_order_release` for live edge weight updates, retaining `std::shared_mutex` only as a comparative benchmark baseline.

## Rationale
- **Zero Read Contention:** In reader-heavy workloads where 16 worker threads read edge weights at tens of millions of lookups/second, even `std::shared_lock` incurs atomic cache-line bouncing on the internal reader counter of the mutex.
- **Wait-Free Route Evaluation:** Worker threads load a thread-local `std::shared_ptr` copy at the beginning of an ALNS iteration. This snapshot pointer dereference is entirely wait-free and guaranteed consistent for the duration of that iteration.
- **Background Copy-on-Write:** The update thread clones the active snapshot, modifies updated edge weights in memory, and atomically swaps the pointer via `std::atomic_store_explicit`.

## Consequences
- Requires short-lived memory allocation overhead during graph weight updates (proportional to edge count $\approx$ few megabytes).
- Read consistency is snapshot-isolated at the trajectory iteration boundary.
