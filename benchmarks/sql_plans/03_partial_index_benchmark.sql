-- Query 3: Partial index query on skewed status (1% PENDING vs 99% DELIVERED/CANCELLED)
-- Demonstrates 95%+ index storage footprint reduction fitting resident in shared_buffers
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT order_id, hub_id, created_at
FROM orders
WHERE hub_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  AND status = 'PENDING'
ORDER BY created_at ASC
LIMIT 50;
