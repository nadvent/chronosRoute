-- Query 5: High-concurrency worker batch claim using SELECT ... FOR UPDATE SKIP LOCKED
-- Demonstrates zero lock-wait convoys under 16 concurrent workers
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT order_id
FROM orders
WHERE status = 'PENDING'
ORDER BY created_at ASC
LIMIT 50
FOR UPDATE SKIP LOCKED;
