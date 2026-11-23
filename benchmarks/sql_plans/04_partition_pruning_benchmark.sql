-- Query 4: Last-hour courier trajectory lookup with Partition Pruning
-- Demonstrates automatic Partition Pruning scanning 1 partition instead of 10M rows
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT recorded_at, location, speed_mps, heading_deg
FROM courier_telemetry
WHERE courier_id = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'
  AND recorded_at >= NOW() - INTERVAL '1 hour'
ORDER BY recorded_at DESC;
