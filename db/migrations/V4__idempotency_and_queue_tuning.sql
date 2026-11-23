-- ==============================================================================
-- ChronosRoute Database Migration V4: Idempotency Store, Queue Tuning & Partitions
-- ==============================================================================

-- 1. Safe Order Status Enum Evolution for Two-Phase Dispatch Claiming
-- Allows Phase 1 transaction to transition PENDING -> BATCHING before releasing
-- the DB connection for the non-transactional gRPC solver call (ADR 0002).
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'BATCHING' AFTER 'PENDING';

-- 2. Idempotency Keys Table for Safe Webhook & Dispatch Retries (ADR 0002)
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key_id VARCHAR(128) PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    response_code INT NOT NULL,
    response_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- B-Tree index on expires_at for efficient TTL expiration cleanup sweeps
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
ON idempotency_keys (expires_at);

-- 3. Queue Index Tuning & MVCC Fillfactor Optimization (Module DB-3)
-- Resolves the mismatch between idx_orders_active (hub_id, created_at) and
-- global batch claiming queries (WHERE status = 'PENDING' ORDER BY created_at ASC)
-- without hub_id predicate, enabling direct Index/Index-Only Scan + SKIP LOCKED.
CREATE INDEX IF NOT EXISTS idx_orders_pending_claim
ON orders (created_at ASC)
INCLUDE (order_id, hub_id)
WHERE status = 'PENDING';

-- Reserve 20% free page space on high-churn tables to enable Heap-Only Tuple (HOT)
-- updates when transitioning order status and updating courier locations.
ALTER TABLE orders SET (fillfactor = 80);
ALTER TABLE couriers SET (fillfactor = 80);
ALTER TABLE outbox_events SET (fillfactor = 80);

-- 4. Filtered Spatial GiST Index on Idle Couriers (Module DB-1)
-- Ensures 01_spatial_gist_benchmark.sql (WHERE status = 'IDLE' AND ST_DWithin(...))
-- and KNN (<->) ordering scan only available couriers in < 4ms with zero Seq Scan.
CREATE INDEX IF NOT EXISTS idx_couriers_idle_geom
ON couriers
USING GIST (last_location)
WHERE status = 'IDLE';

-- 5. Pre-Provisioned Weekly Telemetry Partitions for November 2026 (ADR 0004)
-- Ensures 2026-11-16 and surrounding weeks route to dedicated child partitions
-- rather than falling back to courier_telemetry_default.
CREATE TABLE IF NOT EXISTS courier_telemetry_2026_w46 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-11-09 00:00:00+00') TO ('2026-11-16 00:00:00+00');

CREATE TABLE IF NOT EXISTS courier_telemetry_2026_w47 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-11-16 00:00:00+00') TO ('2026-11-23 00:00:00+00');

CREATE TABLE IF NOT EXISTS courier_telemetry_2026_w48 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-11-23 00:00:00+00') TO ('2026-11-30 00:00:00+00');
