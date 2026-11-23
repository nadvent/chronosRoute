-- ==============================================================================
-- ChronosRoute pgTAP Verification: Schema, Types, Partitions, and Index Existence
-- ==============================================================================

BEGIN;
SELECT plan(13);

-- Extensions
SELECT has_extension('postgis', 'PostGIS spatial extension installed');
SELECT has_extension('btree_gist', 'btree_gist extension installed');

-- Base & V4 Tables
SELECT has_table('hubs', 'hubs table exists');
SELECT has_table('couriers', 'couriers table exists');
SELECT has_table('orders', 'orders table exists');
SELECT has_table('courier_telemetry', 'courier_telemetry partitioned table exists');
SELECT has_table('idempotency_keys', 'idempotency_keys table exists (V4)');
SELECT has_table('courier_telemetry_2026_w47', 'November 2026 weekly partition courier_telemetry_2026_w47 exists (V4)');

-- Spatial, Covering & Partial Queue Indexes (V2 & V4)
SELECT has_index('couriers', 'idx_couriers_geom', 'Spatial GiST index on couriers exists');
SELECT has_index('couriers', 'idx_couriers_idle_geom', 'Filtered GiST spatial index on idle couriers exists (V4)');
SELECT has_index('orders', 'idx_orders_dispatch', 'Multicolumn covering index on orders exists');
SELECT has_index('orders', 'idx_orders_pending_claim', 'Partial covering queue index on orders exists (V4)');
SELECT has_index('idempotency_keys', 'idx_idempotency_keys_expires_at', 'TTL expiration index on idempotency_keys exists (V4)');

SELECT * FROM finish();
ROLLBACK;
