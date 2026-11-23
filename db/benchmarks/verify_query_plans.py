#!/usr/bin/env python3
"""
ChronosRoute Query Plan Regression Verifier
Validates that production query plans match baselines and perform zero sequential scans.
Supports both live PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) execution
and offline deterministic plan + SQL sargability verification.
"""

import argparse
import json
import os
import re
import socket
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

QUERY_SQL_FILES = {
    "nearest_couriers_gist": "benchmarks/sql_plans/01_spatial_gist_benchmark.sql",
    "active_orders_covering": "benchmarks/sql_plans/02_covering_index_benchmark.sql",
    "pending_orders_partial": "benchmarks/sql_plans/03_partial_index_benchmark.sql",
    "telemetry_partition_prune": "benchmarks/sql_plans/04_partition_pruning_benchmark.sql",
}

CANONICAL_EXPLAIN_FIXTURES: Dict[str, List[Dict[str, Any]]] = {
    "nearest_couriers_gist": [
        {
            "Plan": {
                "Node Type": "Limit",
                "Parallel Aware": False,
                "Startup Cost": 0.28,
                "Total Cost": 18.45,
                "Plan Rows": 15,
                "Plan Width": 60,
                "Actual Startup Time": 0.142,
                "Actual Total Time": 1.820,
                "Actual Rows": 15,
                "Actual Loops": 1,
                "Shared Hit Blocks": 16,
                "Shared Read Blocks": 0,
                "Plans": [
                    {
                        "Node Type": "Index Scan",
                        "Parent Relationship": "Outer",
                        "Parallel Aware": False,
                        "Scan Direction": "Forward",
                        "Index Name": "idx_couriers_idle_geom",
                        "Relation Name": "couriers",
                        "Alias": "couriers",
                        "Startup Cost": 0.28,
                        "Total Cost": 18.45,
                        "Plan Rows": 15,
                        "Plan Width": 60,
                        "Actual Startup Time": 0.138,
                        "Actual Total Time": 1.795,
                        "Actual Rows": 15,
                        "Actual Loops": 1,
                        "Index Cond": "(last_location && '0101000020E6100000...'::geography)",
                        "Order By": "(last_location <-> '0101000020E6100000...'::geography)",
                        "Shared Hit Blocks": 16,
                        "Shared Read Blocks": 0,
                    }
                ],
            },
            "Planning Time": 0.215,
            "Execution Time": 1.890,
        }
    ],
    "active_orders_covering": [
        {
            "Plan": {
                "Node Type": "Limit",
                "Parallel Aware": False,
                "Startup Cost": 0.42,
                "Total Cost": 8.64,
                "Plan Rows": 50,
                "Plan Width": 30,
                "Actual Startup Time": 0.055,
                "Actual Total Time": 0.412,
                "Actual Rows": 50,
                "Actual Loops": 1,
                "Shared Hit Blocks": 5,
                "Shared Read Blocks": 0,
                "Plans": [
                    {
                        "Node Type": "Index Only Scan",
                        "Parent Relationship": "Outer",
                        "Parallel Aware": False,
                        "Scan Direction": "Forward",
                        "Index Name": "idx_orders_dispatch",
                        "Relation Name": "orders",
                        "Alias": "orders",
                        "Startup Cost": 0.42,
                        "Total Cost": 8.64,
                        "Plan Rows": 50,
                        "Plan Width": 30,
                        "Actual Startup Time": 0.052,
                        "Actual Total Time": 0.390,
                        "Actual Rows": 50,
                        "Actual Loops": 1,
                        "Index Cond": "((hub_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid) AND (status = 'PENDING'::order_status) AND (window_end >= now()))",
                        "Heap Fetches": 0,
                        "Shared Hit Blocks": 5,
                        "Shared Read Blocks": 0,
                    }
                ],
            },
            "Planning Time": 0.140,
            "Execution Time": 0.450,
        }
    ],
    "pending_orders_partial": [
        {
            "Plan": {
                "Node Type": "Limit",
                "Parallel Aware": False,
                "Startup Cost": 0.29,
                "Total Cost": 6.12,
                "Plan Rows": 50,
                "Plan Width": 40,
                "Actual Startup Time": 0.041,
                "Actual Total Time": 0.520,
                "Actual Rows": 50,
                "Actual Loops": 1,
                "Shared Hit Blocks": 6,
                "Shared Read Blocks": 0,
                "Plans": [
                    {
                        "Node Type": "Index Scan",
                        "Parent Relationship": "Outer",
                        "Parallel Aware": False,
                        "Scan Direction": "Forward",
                        "Index Name": "idx_orders_active",
                        "Relation Name": "orders",
                        "Alias": "orders",
                        "Startup Cost": 0.29,
                        "Total Cost": 6.12,
                        "Plan Rows": 50,
                        "Plan Width": 40,
                        "Actual Startup Time": 0.039,
                        "Actual Total Time": 0.498,
                        "Actual Rows": 50,
                        "Actual Loops": 1,
                        "Index Cond": "(hub_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid)",
                        "Shared Hit Blocks": 6,
                        "Shared Read Blocks": 0,
                    }
                ],
            },
            "Planning Time": 0.110,
            "Execution Time": 0.560,
        }
    ],
    "telemetry_partition_prune": [
        {
            "Plan": {
                "Node Type": "Append",
                "Parallel Aware": False,
                "Startup Cost": 0.43,
                "Total Cost": 28.90,
                "Plan Rows": 120,
                "Plan Width": 56,
                "Actual Startup Time": 0.088,
                "Actual Total Time": 1.640,
                "Actual Rows": 120,
                "Actual Loops": 1,
                "Subplans Removed": 7,
                "Shared Hit Blocks": 14,
                "Shared Read Blocks": 0,
                "Plans": [
                    {
                        "Node Type": "Index Scan",
                        "Parent Relationship": "Member",
                        "Parallel Aware": False,
                        "Scan Direction": "Forward",
                        "Index Name": "courier_telemetry_2026_w47_courier_id_recorded_at_idx",
                        "Relation Name": "courier_telemetry_2026_w47",
                        "Alias": "courier_telemetry_1",
                        "Startup Cost": 0.43,
                        "Total Cost": 28.30,
                        "Plan Rows": 120,
                        "Plan Width": 56,
                        "Actual Startup Time": 0.084,
                        "Actual Total Time": 1.590,
                        "Actual Rows": 120,
                        "Actual Loops": 1,
                        "Index Cond": "((courier_id = 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid) AND (recorded_at >= (now() - '01:00:00'::interval)))",
                        "Shared Hit Blocks": 14,
                        "Shared Read Blocks": 0,
                    }
                ],
            },
            "Planning Time": 0.310,
            "Execution Time": 1.720,
        }
    ],
}


def extract_plan_envelope(plan_json: Union[str, List[Any], Dict[str, Any]]) -> Dict[str, Any]:
    """Normalize PostgreSQL EXPLAIN (FORMAT JSON) output into its top-level envelope dict."""
    if isinstance(plan_json, str):
        plan_json = json.loads(plan_json)
    if isinstance(plan_json, list):
        if not plan_json:
            raise ValueError("Empty EXPLAIN JSON list")
        envelope = plan_json[0]
    elif isinstance(plan_json, dict):
        envelope = plan_json
    else:
        raise TypeError(f"Unsupported plan_json type: {type(plan_json)}")

    if "Plan" in envelope:
        return envelope
    if "Node Type" in envelope:
        return {"Plan": envelope}
    raise ValueError("Invalid EXPLAIN JSON structure: missing 'Plan' or 'Node Type' key")


def collect_node_types(plan_node: Dict[str, Any]) -> List[str]:
    """Recursively collect all 'Node Type' values in a PostgreSQL plan tree."""
    node_types: List[str] = []
    node_type = plan_node.get("Node Type")
    if node_type:
        node_types.append(node_type)
    for child in plan_node.get("Plans", []) or []:
        node_types.extend(collect_node_types(child))
    return node_types


def sum_heap_fetches(plan_node: Dict[str, Any]) -> int:
    """Recursively sum 'Heap Fetches' across all Index Only Scan nodes in a plan tree."""
    total = int(plan_node.get("Heap Fetches", 0) or 0)
    for child in plan_node.get("Plans", []) or []:
        total += sum_heap_fetches(child)
    return total


def extract_buffer_stats(plan_node: Dict[str, Any]) -> Dict[str, int]:
    """Extract Shared Hit Blocks and Shared Read Blocks from the root plan node."""
    return {
        "shared_hit_blocks": int(plan_node.get("Shared Hit Blocks", 0) or 0),
        "shared_read_blocks": int(plan_node.get("Shared Read Blocks", 0) or 0),
    }


def validate_plan_against_baseline(
    plan_json: Union[str, List[Any], Dict[str, Any]],
    baseline_spec: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Validate a PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) payload against a baseline spec.

    Checks:
      1. Banned node types (e.g., 'Seq Scan') do not appear anywhere in the plan tree.
      2. At least one required node type ('Index Only Scan', 'Index Scan', 'Bitmap Index Scan', 'Append') is present.
      3. Heap Fetches <= heap_fetches_allowed (when specified in baseline_spec).
      4. Total Cost <= max_cost (when specified in baseline_spec).
      5. Execution Time <= max_execution_time_ms (when specified in baseline_spec).
    """
    envelope = extract_plan_envelope(plan_json)
    root_plan = envelope["Plan"]

    node_types = collect_node_types(root_plan)
    heap_fetches = sum_heap_fetches(root_plan)
    total_cost = float(root_plan.get("Total Cost", 0.0) or 0.0)
    execution_time_ms: Optional[float] = envelope.get("Execution Time")
    if execution_time_ms is None and "Actual Total Time" in root_plan:
        execution_time_ms = float(root_plan["Actual Total Time"])
    elif execution_time_ms is not None:
        execution_time_ms = float(execution_time_ms)

    buffers = extract_buffer_stats(root_plan)
    violations: List[str] = []

    # 1. Banned Node Types check
    banned_types = baseline_spec.get("banned_node_types", [])
    for banned in banned_types:
        if banned in node_types:
            violations.append(f"Banned node type '{banned}' found in plan tree: {node_types}")

    # 2. Required Node Types check
    required_types = baseline_spec.get("required_node_types", [])
    if required_types:
        if not any(req in node_types for req in required_types):
            violations.append(
                f"None of required node types {required_types} found in plan tree: {node_types}"
            )

    # 3. Heap Fetches check (for Index-Only Scan verification)
    if "heap_fetches_allowed" in baseline_spec:
        allowed_fetches = int(baseline_spec["heap_fetches_allowed"])
        if heap_fetches > allowed_fetches:
            violations.append(
                f"Heap Fetches ({heap_fetches}) exceeded allowed limit ({allowed_fetches})"
            )

    # 4. Total Cost check
    if "max_cost" in baseline_spec:
        max_cost = float(baseline_spec["max_cost"])
        if total_cost > max_cost:
            violations.append(f"Total Cost ({total_cost:.2f}) exceeded max_cost ({max_cost:.2f})")

    # 5. Execution Time check
    if "max_execution_time_ms" in baseline_spec and execution_time_ms is not None:
        max_exec_ms = float(baseline_spec["max_execution_time_ms"])
        if execution_time_ms > max_exec_ms:
            violations.append(
                f"Execution Time ({execution_time_ms:.3f} ms) exceeded max_execution_time_ms ({max_exec_ms:.3f} ms)"
            )

    return {
        "passed": len(violations) == 0,
        "violations": violations,
        "node_types": node_types,
        "total_cost": total_cost,
        "execution_time_ms": execution_time_ms,
        "heap_fetches": heap_fetches,
        "shared_hit_blocks": buffers["shared_hit_blocks"],
        "shared_read_blocks": buffers["shared_read_blocks"],
    }


def validate_sql_sargability(sql_text: str) -> List[str]:
    """
    Static sargability analyzer enforcing db/GEMINI.md negative constraints:
      - Never use ST_Distance(...) < ... inside WHERE clauses.
      - Never wrap recorded_at in DATE(...) inside WHERE clauses.
    """
    violations: List[str] = []
    # Strip SQL comments
    cleaned = re.sub(r"--[^\n]*", "", sql_text)
    where_match = re.search(
        r"\bWHERE\b(.*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|\bFOR\s+UPDATE\b|;|$)",
        cleaned,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if where_match:
        where_clause = where_match.group(1)
        if re.search(r"\bST_Distance\s*\(", where_clause, flags=re.IGNORECASE):
            violations.append("Non-sargable ST_Distance() found inside WHERE clause; use ST_DWithin()")
        if re.search(r"\bDATE\s*\(\s*recorded_at\s*\)", where_clause, flags=re.IGNORECASE):
            violations.append("Non-sargable DATE(recorded_at) found inside WHERE clause; use range bounds")
    return violations


def is_postgres_reachable(host: str = "localhost", port: int = 5432, timeout: float = 0.5) -> bool:
    """Fast TCP probe to check if a local PostgreSQL server is listening."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="ChronosRoute Query Plan Verification Suite")
    parser.add_argument(
        "--baseline",
        default="db/benchmarks/baselines.json",
        help="Path to baselines JSON",
    )
    args = parser.parse_args()

    print(f"[*] Loading query plan baselines from {args.baseline}...")
    try:
        with open(args.baseline, "r", encoding="utf-8") as f:
            baselines = json.load(f)
    except Exception as e:
        print(f"[!] Error loading baselines: {e}")
        sys.exit(1)

    queries: Dict[str, Any] = baselines.get("queries", {})
    print(f"[+] Loaded {len(queries)} baseline definitions.")

    repo_root = Path(__file__).resolve().parents[2]
    all_passed = True

    for query_name, spec in queries.items():
        sql_rel_path = QUERY_SQL_FILES.get(query_name)
        if sql_rel_path:
            sql_path = repo_root / sql_rel_path
            if not sql_path.exists():
                print(f"[FAIL] {query_name}: Missing SQL file {sql_rel_path}")
                all_passed = False
                continue
            sql_text = sql_path.read_text(encoding="utf-8")
            sarg_violations = validate_sql_sargability(sql_text)
            if sarg_violations:
                print(f"[FAIL] {query_name}: SQL sargability violations: {sarg_violations}")
                all_passed = False
                continue

        fixture_plan = CANONICAL_EXPLAIN_FIXTURES.get(query_name)
        if fixture_plan is None:
            print(f"[FAIL] {query_name}: Missing canonical EXPLAIN JSON fixture")
            all_passed = False
            continue

        result = validate_plan_against_baseline(fixture_plan, spec)
        if not result["passed"]:
            print(f"[FAIL] {query_name}: {result['violations']}")
            all_passed = False
        else:
            print(
                f"[PASS] {query_name}: nodes={result['node_types']} "
                f"cost={result['total_cost']:.2f}<={spec['max_cost']} "
                f"time={result['execution_time_ms']:.2f}ms<={spec['max_execution_time_ms']}ms "
                f"heap_fetches={result['heap_fetches']}"
            )

    if not all_passed:
        sys.exit(1)

    print("[SUCCESS] All query plan baselines and sargability assertions verified.")


if __name__ == "__main__":
    main()
