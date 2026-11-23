-- ==============================================================================
-- ChronosRoute Database Migration V3: Declarative Range Partitioning for Telemetry
-- ==============================================================================

-- Master partitioned telemetry table: 10M+ rows target
CREATE TABLE courier_telemetry (
    telemetry_id UUID DEFAULT uuid_generate_v4(),
    courier_id UUID NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    location GEOGRAPHY(Point, 4326) NOT NULL,
    speed_mps REAL,
    heading_deg REAL,
    battery_pct SMALLINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (courier_id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Child partitions (Weekly partitions for current & surrounding weeks)
-- In production, partitions are pre-provisioned via pg_partman or cron
CREATE TABLE courier_telemetry_2026_w42 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-10-12 00:00:00+00') TO ('2026-10-19 00:00:00+00');

CREATE TABLE courier_telemetry_2026_w43 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-10-19 00:00:00+00') TO ('2026-10-26 00:00:00+00');

CREATE TABLE courier_telemetry_2026_w44 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-10-26 00:00:00+00') TO ('2026-11-02 00:00:00+00');

CREATE TABLE courier_telemetry_2026_w45 PARTITION OF courier_telemetry
    FOR VALUES FROM ('2026-11-02 00:00:00+00') TO ('2026-11-09 00:00:00+00');

-- Default partition fallback
CREATE TABLE courier_telemetry_default PARTITION OF courier_telemetry DEFAULT;

-- Local Indexes per partition:
-- 1. BRIN Index on recorded_at for chronological append-only speed & minimal RAM usage
CREATE INDEX idx_telemetry_brin ON courier_telemetry USING BRIN (recorded_at);

-- 2. Local Composite B-Tree for courier historical trajectory lookups
CREATE INDEX idx_telemetry_courier_time ON courier_telemetry (courier_id, recorded_at DESC);

-- 3. Local GiST spatial index for spatial breadcrumb queries
CREATE INDEX idx_telemetry_geom ON courier_telemetry USING GIST (location);
