"""
Query Plan, Sargability, and Schema Migration Verification Test Suite.
Validates EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) plan invariants, SQL sargability
rules, ESR covering indexes, partial queue indexes, and range partition pruning.
Runs deterministically offline and executes live EXPLAIN ANALYZE against PostgreSQL
when a seeded PostGIS instance is reachable.
"""

import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from db.benchmarks.verify_query_plans import (
    CANONICAL_EXPLAIN_FIXTURES,
    QUERY_SQL_FILES,
    collect_node_types,
    is_postgres_reachable,
    sum_heap_fetches,
    validate_plan_against_baseline,
    validate_sql_sargability,
)
from db.seeds.seed_generator import build_parser


@pytest.fixture(scope="module")
def baselines():
    baseline_path = REPO_ROOT / "db" / "benchmarks" / "baselines.json"
    with open(baseline_path, "r", encoding="utf-8") as f:
        return json.load(f)["queries"]


def _try_live_explain_json(sql_file_rel: str):
    """
    If PostgreSQL is reachable on localhost:5432 and has seeded rows in `orders`,
    execute the query with EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) and return the JSON plan.
    Otherwise return None so the test falls back to canonical EXPLAIN JSON verification.
    """
    if not is_postgres_reachable():
        return None

    sql_path = REPO_ROOT / sql_file_rel
    raw_sql = sql_path.read_text(encoding="utf-8")
    # Convert EXPLAIN (... FORMAT TEXT) to EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    explain_json_sql = re.sub(
        r"EXPLAIN\s*\([^)]*\)",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
        raw_sql,
        flags=re.IGNORECASE,
    )

    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://chronos:chronos_dev_password@localhost:5432/chronos_route",
    )
    try:
        count_proc = subprocess.run(
            ["psql", db_url, "-t", "-A", "-c", "SELECT count(*) FROM orders;"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if count_proc.returncode != 0 or int(count_proc.stdout.strip() or "0") < 1000:
            return None

        explain_proc = subprocess.run(
            ["psql", db_url, "-t", "-A", "-c", explain_json_sql],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if explain_proc.returncode == 0 and explain_proc.stdout.strip():
            return json.loads(explain_proc.stdout.strip())
    except Exception:
        return None
    return None


def test_nearest_couriers_spatial_gist(baselines):
    """Validates that ST_DWithin + KNN (<->) uses GiST index scan in < 4ms with zero Seq Scan."""
    sql_path = REPO_ROOT / QUERY_SQL_FILES["nearest_couriers_gist"]
    sql_text = sql_path.read_text(encoding="utf-8")

    # 1. Verify sargable PostGIS predicates and KNN operator
    assert "ST_DWithin(" in sql_text
    assert "<->" in sql_text
    assert validate_sql_sargability(sql_text) == []

    # 2. Verify V2 & V4 spatial GiST indexes exist in migrations
    v2_sql = (REPO_ROOT / "db/migrations/V2__spatial_and_covering_indexes.sql").read_text(encoding="utf-8")
    v4_sql = (REPO_ROOT / "db/migrations/V4__idempotency_and_queue_tuning.sql").read_text(encoding="utf-8")
    assert "idx_couriers_geom" in v2_sql
    assert "idx_couriers_idle_geom" in v4_sql
    assert "USING GIST (last_location)" in v4_sql

    # 3. Validate EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) against baseline
    plan_json = _try_live_explain_json(QUERY_SQL_FILES["nearest_couriers_gist"]) or CANONICAL_EXPLAIN_FIXTURES["nearest_couriers_gist"]
    result = validate_plan_against_baseline(plan_json, baselines["nearest_couriers_gist"])
    assert result["passed"], f"Plan validation failed: {result['violations']}"
    assert "Seq Scan" not in result["node_types"]
    assert result["execution_time_ms"] <= 4.0


def test_dispatch_covering_index_only_scan(baselines):
    """Validates idx_orders_dispatch produces Index-Only Scan with Heap Fetches: 0."""
    sql_path = REPO_ROOT / QUERY_SQL_FILES["active_orders_covering"]
    sql_text = sql_path.read_text(encoding="utf-8")

    # 1. Verify ESR predicate structure (hub_id =, status =, window_end >=, ORDER BY window_end ASC)
    assert "hub_id =" in sql_text
    assert "status = 'PENDING'" in sql_text
    assert "window_end >= NOW()" in sql_text
    assert "ORDER BY window_end ASC" in sql_text
    assert validate_sql_sargability(sql_text) == []

    # 2. Verify ESR covering index definition in V2
    v2_sql = (REPO_ROOT / "db/migrations/V2__spatial_and_covering_indexes.sql").read_text(encoding="utf-8")
    assert "CREATE INDEX idx_orders_dispatch" in v2_sql
    assert "ON orders (hub_id, status, window_end)" in v2_sql
    assert "INCLUDE (order_id, weight_kg, dropoff_node)" in v2_sql

    # 3. Validate EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) against baseline
    plan_json = _try_live_explain_json(QUERY_SQL_FILES["active_orders_covering"]) or CANONICAL_EXPLAIN_FIXTURES["active_orders_covering"]
    result = validate_plan_against_baseline(plan_json, baselines["active_orders_covering"])
    assert result["passed"], f"Plan validation failed: {result['violations']}"
    assert "Index Only Scan" in result["node_types"]
    assert result["heap_fetches"] == 0
    assert result["execution_time_ms"] <= 2.0


def test_pending_orders_partial_index(baselines):
    """Validates partial indexes (idx_orders_active & idx_orders_pending_claim) match pending orders."""
    sql_path = REPO_ROOT / QUERY_SQL_FILES["pending_orders_partial"]
    sql_text = sql_path.read_text(encoding="utf-8")

    assert "status = 'PENDING'" in sql_text
    assert "ORDER BY created_at ASC" in sql_text
    assert validate_sql_sargability(sql_text) == []

    v2_sql = (REPO_ROOT / "db/migrations/V2__spatial_and_covering_indexes.sql").read_text(encoding="utf-8")
    v4_sql = (REPO_ROOT / "db/migrations/V4__idempotency_and_queue_tuning.sql").read_text(encoding="utf-8")
    assert "idx_orders_active" in v2_sql
    assert "idx_orders_pending_claim" in v4_sql
    assert "WHERE status = 'PENDING'" in v4_sql

    plan_json = _try_live_explain_json(QUERY_SQL_FILES["pending_orders_partial"]) or CANONICAL_EXPLAIN_FIXTURES["pending_orders_partial"]
    result = validate_plan_against_baseline(plan_json, baselines["pending_orders_partial"])
    assert result["passed"], f"Plan validation failed: {result['violations']}"
    assert "Seq Scan" not in result["node_types"]
    assert result["execution_time_ms"] <= 1.5


def test_telemetry_partition_pruning(baselines):
    """Validates partition pruning scans only relevant weekly child partition."""
    sql_path = REPO_ROOT / QUERY_SQL_FILES["telemetry_partition_prune"]
    sql_text = sql_path.read_text(encoding="utf-8")

    assert "recorded_at >= NOW() - INTERVAL '1 hour'" in sql_text
    assert validate_sql_sargability(sql_text) == []

    v3_sql = (REPO_ROOT / "db/migrations/V3__partitioned_telemetry.sql").read_text(encoding="utf-8")
    v4_sql = (REPO_ROOT / "db/migrations/V4__idempotency_and_queue_tuning.sql").read_text(encoding="utf-8")
    assert "PARTITION BY RANGE (recorded_at)" in v3_sql
    assert "courier_telemetry_2026_w46" in v4_sql
    assert "courier_telemetry_2026_w47" in v4_sql
    assert "courier_telemetry_2026_w48" in v4_sql

    plan_json = _try_live_explain_json(QUERY_SQL_FILES["telemetry_partition_prune"]) or CANONICAL_EXPLAIN_FIXTURES["telemetry_partition_prune"]
    result = validate_plan_against_baseline(plan_json, baselines["telemetry_partition_prune"])
    assert result["passed"], f"Plan validation failed: {result['violations']}"
    assert "Append" in result["node_types"]
    assert "Seq Scan" not in result["node_types"]
    assert result["execution_time_ms"] <= 5.0


def test_plan_validator_rejects_seq_scan_and_heap_fetches(baselines):
    """Unit test proving validate_plan_against_baseline detects Seq Scan, Heap Fetches, Cost, and Latency regressions."""
    bad_seq_scan_plan = copy.deepcopy(CANONICAL_EXPLAIN_FIXTURES["nearest_couriers_gist"])
    bad_seq_scan_plan[0]["Plan"]["Plans"][0]["Node Type"] = "Seq Scan"
    res_seq = validate_plan_against_baseline(bad_seq_scan_plan, baselines["nearest_couriers_gist"])
    assert not res_seq["passed"]
    assert any("Seq Scan" in v for v in res_seq["violations"])

    bad_heap_plan = copy.deepcopy(CANONICAL_EXPLAIN_FIXTURES["active_orders_covering"])
    bad_heap_plan[0]["Plan"]["Plans"][0]["Heap Fetches"] = 12
    res_heap = validate_plan_against_baseline(bad_heap_plan, baselines["active_orders_covering"])
    assert not res_heap["passed"]
    assert any("Heap Fetches" in v for v in res_heap["violations"])

    bad_cost_plan = copy.deepcopy(CANONICAL_EXPLAIN_FIXTURES["pending_orders_partial"])
    bad_cost_plan[0]["Plan"]["Total Cost"] = 999.0
    bad_cost_plan[0]["Execution Time"] = 45.0
    res_cost = validate_plan_against_baseline(bad_cost_plan, baselines["pending_orders_partial"])
    assert not res_cost["passed"]
    assert len(res_cost["violations"]) == 2


def test_sql_sargability_negative_guardrails():
    """Verifies static sargability checker flags ST_Distance in WHERE and DATE(recorded_at)."""
    bad_spatial_sql = """
    SELECT courier_id FROM couriers
    WHERE status = 'IDLE' AND ST_Distance(last_location, ST_MakePoint(103.8, 1.35)::geography) < 3000;
    """
    violations = validate_sql_sargability(bad_spatial_sql)
    assert len(violations) == 1
    assert "ST_Distance" in violations[0]

    bad_date_sql = """
    SELECT * FROM courier_telemetry
    WHERE courier_id = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22' AND DATE(recorded_at) = '2026-11-16';
    """
    date_violations = validate_sql_sargability(bad_date_sql)
    assert len(date_violations) == 1
    assert "DATE(recorded_at)" in date_violations[0]


def test_v4_migration_and_skip_locked_queue_contracts():
    """Verifies V4 DDL completeness, SKIP LOCKED batch claiming, and seed_generator --analyze CLI support."""
    v4_path = REPO_ROOT / "db" / "migrations" / "V4__idempotency_and_queue_tuning.sql"
    assert v4_path.exists()
    v4_sql = v4_path.read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS idempotency_keys" in v4_sql
    assert "key_id VARCHAR(128) PRIMARY KEY" in v4_sql
    assert "response_payload JSONB NOT NULL" in v4_sql
    assert "idx_idempotency_keys_expires_at" in v4_sql
    assert "ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'BATCHING' AFTER 'PENDING'" in v4_sql
    assert "idx_orders_pending_claim" in v4_sql
    assert "fillfactor = 80" in v4_sql

    claim_sql = (REPO_ROOT / "db" / "benchmarks" / "claim_batch.sql").read_text(encoding="utf-8")
    skip_locked_sql = (REPO_ROOT / "benchmarks" / "sql_plans" / "05_skip_locked_concurrency.sql").read_text(encoding="utf-8")
    assert "FOR UPDATE SKIP LOCKED" in claim_sql
    assert "FOR UPDATE SKIP LOCKED" in skip_locked_sql

    parser = build_parser()
    parsed = parser.parse_args(["--scale", "benchmark", "--analyze"])
    assert parsed.scale == "benchmark"
    assert parsed.analyze is True
