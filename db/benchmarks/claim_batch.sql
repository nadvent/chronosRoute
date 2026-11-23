-- ==============================================================================
-- ChronosRoute Database Benchmark: High-concurrency SKIP LOCKED batch claiming
-- Usage: pgbench -U chronos -c 16 -j 4 -T 30 -f claim_batch.sql chronos_route
-- ==============================================================================

BEGIN;

-- Atomically claim up to 50 pending orders for dispatch without lock convoys
WITH claimed_orders AS (
    SELECT order_id
    FROM orders
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
)
UPDATE orders o
SET status = 'ASSIGNED',
    updated_at = NOW(),
    version = o.version + 1
FROM claimed_orders c
WHERE o.order_id = c.order_id;

COMMIT;
