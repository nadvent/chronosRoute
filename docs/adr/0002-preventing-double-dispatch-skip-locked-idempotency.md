# ADR 0002: Preventing Double-Dispatch Race Conditions with SELECT FOR UPDATE SKIP LOCKED and Idempotency Keys

## Status
Accepted

## Context
When dozens of concurrent dispatch workers in `orchestrator-java` poll the database to claim batches of pending delivery orders, traditional locking approaches cause severe contention:
- Plain `SELECT ... FOR UPDATE` causes lock-wait convoys: worker threads block waiting on identical rows, serializing throughput and causing thread pool starvation.
- Optimistic locking alone (`@Version`) causes high transaction abort and rollback rates under high load, wasting database CPU cycles.
- Network retries from upstream webhook delivery systems risk double-dispatching the same order to multiple couriers.

## Decision
1. Workers claim unassigned orders using PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50`.
2. Every state-altering command must provide an `Idempotency-Key` header, validated against an `idempotency_keys` table within the same transaction.
3. Order transitions and corresponding `outbox_events` are committed atomically within the same transactional boundary.

## Rationale
- **Zero Lock-Wait Convoys:** `SKIP LOCKED` instructs the PostgreSQL query engine to skip any row currently locked by another transaction, allowing 16+ concurrent workers to claim disjoint batches simultaneously without contention.
- **Strict Single-Delivery Invariant:** Once locked, the worker updates the order status to `ASSIGNED` before committing, preventing any other worker from ever seeing or processing the same order.
- **Safe Retries:** The unique idempotency key ensures duplicate HTTP requests replay the cached response rather than triggering re-dispatch.

## Consequences
- Requires covering or partial indexes (`idx_orders_active` and `idx_outbox_pending`) to prevent sequential scans during queue polling.
- Transactions must be kept exceptionally short (no RPC calls inside the transaction).
