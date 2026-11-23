# ADR 0004: PostgreSQL Index & Partition Tuning for 10M+ Geospatial Telemetry Rows

## Status
Accepted

## Context
With 2,000 active couriers transmitting GPS pings every 2–5 seconds, the system accumulates > 10,000,000 telemetry rows weekly. Storing this volume in a single monolithic table with traditional B-tree indexes leads to:
- Severe index write amplification and page splits during high-throughput ingestion.
- Table bloat and heavy vacuum degradation.
- Degraded trajectory lookup performance (> 2,000 ms query times due to scanning tens of millions of rows).

## Decision
1. Partition `courier_telemetry` by range on `recorded_at` (`PARTITION BY RANGE (recorded_at)`) with weekly child partitions.
2. Apply lightweight Block Range Indexes (BRIN) on `recorded_at` alongside local compound B-tree indexes `(courier_id, recorded_at DESC)`.
3. Ingest GPS pings using `asyncpg` micro-batch `COPY` / `UNNEST` instead of ORM-based single-row inserts.

## Rationale
- **Partition Pruning:** Queries targeting recent courier history (e.g., last 1 hour) automatically prune away all older child partitions, scanning only the active partition rather than 10M historical rows.
- **Minimal Index Overhead with BRIN:** BRIN indexes store min/max values for physical page ranges, occupying less than 1% of the disk and RAM space required by standard B-trees while preserving fast range searches on append-only time series.
- **Instant Data Retention Drops:** Expired telemetry partitions can be removed instantly via `DROP TABLE courier_telemetry_y2026wXX` in milliseconds, generating zero WAL bloat and bypassing `DELETE` + `VACUUM` locks.
- **High-Throughput Ingestion:** `asyncpg` `copy_records_to_table` streams raw binary tuples directly to PostgreSQL, reaching 15,000+ rows/sec compared to ~400 rows/sec with standard ORM inserts.

## Consequences
- Requires automated partition pre-creation (e.g. pg_partman or cron job).
- Cross-partition updates must be avoided (telemetry is strictly append-only).
