-- Query 2: Active dispatch polling with ESR rule covering index
-- Demonstrates Index-Only Scan with Heap Fetches: 0
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT order_id, weight_kg, dropoff_node
FROM orders
WHERE hub_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  AND status = 'PENDING'
  AND window_end >= NOW()
ORDER BY window_end ASC
LIMIT 50;
