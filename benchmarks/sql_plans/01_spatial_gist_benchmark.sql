-- Query 1: Nearest available couriers within 3 km using PostGIS GiST Index
-- Demonstrates GiST Index Scan (<4ms) vs. brute force spherical trigonometry (>450ms)
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT courier_id,
       name,
       ST_Distance(last_location, ST_SetSRID(ST_MakePoint(103.8198, 1.3521), 4326)::geography) AS distance_meters
FROM couriers
WHERE status = 'IDLE'
  AND ST_DWithin(last_location, ST_SetSRID(ST_MakePoint(103.8198, 1.3521), 4326)::geography, 3000)
ORDER BY last_location <-> ST_SetSRID(ST_MakePoint(103.8198, 1.3521), 4326)::geography
LIMIT 15;
