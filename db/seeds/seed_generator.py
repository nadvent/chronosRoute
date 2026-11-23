#!/usr/bin/env python3
"""
ChronosRoute Deterministic Data Seeder
Populates PostgreSQL + PostGIS with:
- 2,000 couriers
- 500,000 delivery orders (99% historical DELIVERED/CANCELLED, 1% hot PENDING)
- 10,000,000 partitioned GPS telemetry rows using asyncpg COPY for 15,000+ rows/sec throughput.
"""

import argparse
import asyncio
import os
import random
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

try:
    import asyncpg
except ImportError:
    asyncpg = None


class PsqlCopyConnection:
    """Fallback PostgreSQL connection using `psql` CLI COPY FROM STDIN when asyncpg C-extensions are unavailable."""

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn

    @staticmethod
    def _format_cell(val) -> str:
        if val is None:
            return r"\N"
        if isinstance(val, datetime):
            return val.isoformat()
        return str(val).replace("\t", " ").replace("\n", " ")

    async def execute(self, query: str) -> str:
        proc = subprocess.run(
            ["psql", self.dsn, "-v", "ON_ERROR_STOP=1", "-q", "-c", query],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f"psql execute failed for: {query}")
        return proc.stdout.strip()

    async def copy_records_to_table(self, table_name: str, *, records: list, columns: list) -> None:
        if not records:
            return
        cols_sql = ", ".join(columns)
        copy_sql = f"COPY {table_name} ({cols_sql}) FROM STDIN;"
        payload = "\n".join(
            "\t".join(self._format_cell(v) for v in row) for row in records
        ) + "\n"
        proc = subprocess.run(
            ["psql", self.dsn, "-v", "ON_ERROR_STOP=1", "-q", "-c", copy_sql],
            input=payload,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f"psql COPY failed on {table_name}")

    async def close(self) -> None:
        return None

# Seed coordinate bounds across supported metropolitan regions (London default)
REGION_CENTERS = {
    "london": (51.5074, -0.1278),
    "kl": (3.1390, 101.6869),
    "singapore": (1.3521, 103.8198),
    "berlin": (52.5200, 13.4050),
    "sf": (37.7749, -122.4194),
    "tokyo": (35.6762, 139.6503),
}
DEFAULT_REGION = "london"
BASE_LAT, BASE_LON = REGION_CENTERS[DEFAULT_REGION]
LAT_SPREAD = 0.15
LON_SPREAD = 0.15

SCALE_CONFIGS = {
    "dev": {
        "hubs": 5,
        "couriers": 50,
        "orders": 1000,
        "telemetry": 10000,
        "batch_size": 2000,
    },
    "benchmark": {
        "hubs": 20,
        "couriers": 2000,
        "orders": 500000,
        "telemetry": 10000000,
        "batch_size": 50000,
    },
}

ANALYZE_TABLES = [
    "hubs",
    "couriers",
    "orders",
    "routes",
    "outbox_events",
    "idempotency_keys",
    "courier_telemetry",
]


def random_point(base_lat: float = BASE_LAT, base_lon: float = BASE_LON):
    lat = base_lat + (random.random() - 0.5) * LAT_SPREAD
    lon = base_lon + (random.random() - 0.5) * LON_SPREAD
    return f"SRID=4326;POINT({lon} {lat})"


async def seed_hubs(conn, count: int, base_lat: float = BASE_LAT, base_lon: float = BASE_LON):
    print(f"[*] Seeding {count} hubs...")
    hub_ids = []
    rows = []
    for i in range(count):
        h_id = (
            uuid.UUID("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")
            if i == 0
            else uuid.uuid4()
        )
        hub_ids.append(h_id)
        rows.append((
            h_id,
            f"Central Distribution Hub #{i+1}",
            random_point(base_lat, base_lon),
            random.randint(400, 1000),
            datetime.now(timezone.utc),
        ))
    await conn.copy_records_to_table(
        "hubs",
        records=rows,
        columns=["hub_id", "name", "location", "capacity_orders_per_hour", "created_at"],
    )
    print(f"[+] Successfully seeded {count} hubs.")
    return hub_ids


async def seed_couriers(conn, count: int, base_lat: float = BASE_LAT, base_lon: float = BASE_LON):
    print(f"[*] Seeding {count} couriers...")
    courier_ids = []
    rows = []
    now = datetime.now(timezone.utc)
    statuses = ["IDLE", "ASSIGNED", "EN_ROUTE_PICKUP", "EN_ROUTE_DROPOFF", "OFFLINE"]
    weights = [0.4, 0.3, 0.15, 0.1, 0.05]

    for i in range(count):
        c_id = (
            uuid.UUID("b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22")
            if i == 0
            else uuid.uuid4()
        )
        courier_ids.append(c_id)
        status = "IDLE" if i == 0 else random.choices(statuses, weights=weights)[0]
        shift_start = now - timedelta(hours=random.randint(1, 4))
        shift_end = shift_start + timedelta(hours=8)
        rows.append((
            c_id,
            f"Courier-{i+1:05d}",
            status,
            random.choice([25.0, 30.0, 50.0]),
            50.0,
            random_point(base_lat, base_lon),
            now - timedelta(seconds=random.randint(5, 120)),
            shift_start,
            shift_end,
            now - timedelta(days=random.randint(10, 30)),
        ))
    await conn.copy_records_to_table(
        "couriers",
        records=rows,
        columns=[
            "courier_id",
            "name",
            "status",
            "current_capacity_kg",
            "max_capacity_kg",
            "last_location",
            "last_ping_at",
            "shift_start",
            "shift_end",
            "created_at",
        ],
    )
    print(f"[+] Successfully seeded {count} couriers.")
    return courier_ids


async def seed_orders(
    conn,
    count: int,
    hub_ids: list,
    courier_ids: list,
    batch_size: int,
    base_lat: float = BASE_LAT,
    base_lon: float = BASE_LON,
):
    print(f"[*] Seeding {count} orders (99% historical DELIVERED/CANCELLED, 1% hot PENDING)...")
    now = datetime.now(timezone.utc)
    total_inserted = 0

    while total_inserted < count:
        current_batch = min(batch_size, count - total_inserted)
        rows = []
        for _ in range(current_batch):
            o_id = uuid.uuid4()
            hub_id = random.choice(hub_ids)
            is_pending = random.random() < 0.01  # 1% active PENDING for partial index verification

            if is_pending:
                status = "PENDING"
                c_id = None
                created_at = now - timedelta(minutes=random.randint(1, 30))
                window_start = created_at + timedelta(minutes=15)
                window_end = window_start + timedelta(minutes=45)
            else:
                status = random.choice(["DELIVERED", "DELIVERED", "DELIVERED", "CANCELLED"])
                c_id = random.choice(courier_ids)
                days_ago = random.randint(1, 60)
                created_at = now - timedelta(days=days_ago, minutes=random.randint(0, 1440))
                window_start = created_at + timedelta(minutes=15)
                window_end = window_start + timedelta(minutes=45)

            rows.append((
                o_id,
                hub_id,
                c_id,
                status,
                round(random.uniform(0.5, 15.0), 2),
                random_point(base_lat, base_lon),
                random_point(base_lat, base_lon),
                random.randint(100000, 999999),
                window_start,
                window_end,
                random.choice([180, 240, 300, 480]),
                created_at,
                created_at + timedelta(minutes=40),
                1,
            ))

        await conn.copy_records_to_table(
            "orders",
            records=rows,
            columns=[
                "order_id",
                "hub_id",
                "courier_id",
                "status",
                "weight_kg",
                "pickup_location",
                "dropoff_location",
                "dropoff_node",
                "window_start",
                "window_end",
                "service_duration_seconds",
                "created_at",
                "updated_at",
                "version",
            ],
        )
        total_inserted += current_batch
        print(f"    -> Orders inserted: {total_inserted}/{count} ({(total_inserted/count)*100:.1f}%)")


async def seed_telemetry(
    conn,
    count: int,
    courier_ids: list,
    batch_size: int,
    base_lat: float = BASE_LAT,
    base_lon: float = BASE_LON,
):
    print(f"[*] Seeding {count} telemetry pings using asyncpg COPY into partitioned tables...")
    now = datetime.now(timezone.utc)
    total_inserted = 0
    start_time = time.time()

    while total_inserted < count:
        current_batch = min(batch_size, count - total_inserted)
        rows = []
        for _ in range(current_batch):
            c_id = random.choice(courier_ids)
            # Distribute timestamps across current week partitions
            days_ago = random.uniform(0, 14)
            recorded_at = now - timedelta(days=days_ago)
            rows.append((
                uuid.uuid4(),
                c_id,
                recorded_at,
                random_point(base_lat, base_lon),
                round(random.uniform(0.0, 22.0), 1),
                round(random.uniform(0.0, 359.0), 1),
                random.randint(20, 100),
                recorded_at,
            ))

        await conn.copy_records_to_table(
            "courier_telemetry",
            records=rows,
            columns=[
                "telemetry_id",
                "courier_id",
                "recorded_at",
                "location",
                "speed_mps",
                "heading_deg",
                "battery_pct",
                "created_at",
            ],
        )
        total_inserted += current_batch
        elapsed = time.time() - start_time
        rate = total_inserted / elapsed if elapsed > 0 else 0
        print(f"    -> Telemetry inserted: {total_inserted}/{count} ({rate:.0f} rows/sec)")


async def run_vacuum_analyze(conn):
    """Refresh PostgreSQL planner histograms and Visibility Map bits for Index-Only Scans."""
    print("[*] Running VACUUM ANALYZE on seeded tables to update planner statistics and Visibility Map...")
    for table in ANALYZE_TABLES:
        try:
            await conn.execute(f"VACUUM ANALYZE {table};")
            print(f"    -> VACUUM ANALYZE {table} complete.")
        except Exception as exc:
            print(f"    [!] Skipping VACUUM ANALYZE on {table}: {exc}")
    print("[+] VACUUM ANALYZE completed.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic PostGIS Seeder for ChronosRoute")
    parser.add_argument(
        "--scale",
        choices=["dev", "benchmark"],
        default="dev",
        help="Scale preset (dev: 1k orders, benchmark: 500k orders / 10M pings)",
    )
    parser.add_argument(
        "--region",
        choices=list(REGION_CENTERS.keys()),
        default=DEFAULT_REGION,
        help=f"Geographic region center for seeded coordinates (default: {DEFAULT_REGION})",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="Truncate existing tables before seeding",
    )
    parser.add_argument(
        "--analyze",
        action="store_true",
        help="Run VACUUM ANALYZE after seeding to update planner statistics and Visibility Map",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Deterministic PRNG seed (default: 42)",
    )
    parser.add_argument(
        "--db-url",
        default=os.getenv(
            "DATABASE_ASYNC_URL",
            "postgresql://chronos:chronos_dev_password@localhost:5432/chronos_route",
        ),
    )
    return parser


async def main():
    parser = build_parser()
    args = parser.parse_args()

    base_lat, base_lon = REGION_CENTERS[args.region]
    random.seed(args.seed)
    cfg = SCALE_CONFIGS[args.scale]
    print(
        f"Starting seed in '{args.scale}' mode (region={args.region} "
        f"[{base_lat:.4f}, {base_lon:.4f}], seed={args.seed}) on database: {args.db_url}"
    )

    # Strip protocol adapter if needed for asyncpg
    url = args.db_url.replace("postgresql+asyncpg://", "postgresql://")

    if asyncpg is not None:
        try:
            conn = await asyncpg.connect(url)
        except Exception as e:
            print(f"[!] Could not connect to PostgreSQL: {e}")
            print("[!] Ensure Postgres container is running (`docker compose up -d postgres`)")
            sys.exit(1)
    elif shutil.which("psql") is not None:
        conn = PsqlCopyConnection(url)
        try:
            await conn.execute("SELECT 1;")
        except Exception as e:
            print(f"[!] Could not connect to PostgreSQL via psql: {e}")
            sys.exit(1)
    else:
        print("[!] Neither asyncpg nor psql CLI is available in the active environment.")
        sys.exit(1)

    try:
        if args.truncate:
            print("[*] Truncating existing tables before seeding...")
            await conn.execute(
                "TRUNCATE TABLE routes, outbox_events, idempotency_keys, orders, couriers, hubs, courier_telemetry CASCADE;"
            )
        hub_ids = await seed_hubs(conn, cfg["hubs"], base_lat=base_lat, base_lon=base_lon)
        courier_ids = await seed_couriers(conn, cfg["couriers"], base_lat=base_lat, base_lon=base_lon)
        await seed_orders(
            conn,
            cfg["orders"],
            hub_ids,
            courier_ids,
            cfg["batch_size"],
            base_lat=base_lat,
            base_lon=base_lon,
        )
        await seed_telemetry(
            conn,
            cfg["telemetry"],
            courier_ids,
            cfg["batch_size"],
            base_lat=base_lat,
            base_lon=base_lon,
        )
        if args.analyze:
            await run_vacuum_analyze(conn)
        print("\n[SUCCESS] Database successfully populated for EXPLAIN ANALYZE benchmarks!")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
