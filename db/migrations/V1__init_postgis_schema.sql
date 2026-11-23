-- ==============================================================================
-- ChronosRoute Database Migration V1: Initial Base Schema
-- ==============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Enum Types
CREATE TYPE order_status AS ENUM (
    'PENDING',
    'ASSIGNED',
    'PICKED_UP',
    'IN_TRANSIT',
    'DELIVERED',
    'CANCELLED'
);

CREATE TYPE courier_status AS ENUM (
    'OFFLINE',
    'IDLE',
    'ASSIGNED',
    'EN_ROUTE_PICKUP',
    'EN_ROUTE_DROPOFF'
);

-- Hubs / Depots / Dark Stores
CREATE TABLE hubs (
    hub_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(128) NOT NULL,
    location GEOGRAPHY(Point, 4326) NOT NULL,
    capacity_orders_per_hour INT NOT NULL DEFAULT 500,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Couriers / Drivers
CREATE TABLE couriers (
    courier_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(128) NOT NULL,
    status courier_status NOT NULL DEFAULT 'IDLE',
    current_capacity_kg NUMERIC(6, 2) NOT NULL DEFAULT 30.00,
    max_capacity_kg NUMERIC(6, 2) NOT NULL DEFAULT 30.00,
    last_location GEOGRAPHY(Point, 4326) NOT NULL,
    last_ping_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shift_start TIMESTAMPTZ NOT NULL,
    shift_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delivery Orders
CREATE TABLE orders (
    order_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hub_id UUID NOT NULL REFERENCES hubs(hub_id),
    courier_id UUID REFERENCES couriers(courier_id),
    status order_status NOT NULL DEFAULT 'PENDING',
    weight_kg NUMERIC(6, 2) NOT NULL DEFAULT 2.50,
    pickup_location GEOGRAPHY(Point, 4326) NOT NULL,
    dropoff_location GEOGRAPHY(Point, 4326) NOT NULL,
    dropoff_node BIGINT NOT NULL DEFAULT 0, -- OSM road network node ID
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    service_duration_seconds INT NOT NULL DEFAULT 300,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INT NOT NULL DEFAULT 0 -- Optimistic lock support
);

-- Routes History & Plan
CREATE TABLE routes (
    route_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    courier_id UUID NOT NULL REFERENCES couriers(courier_id),
    hub_id UUID NOT NULL REFERENCES hubs(hub_id),
    total_distance_meters INT NOT NULL,
    total_duration_seconds INT NOT NULL,
    route_geometry GEOGRAPHY(LineString, 4326),
    scheduled_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transactional Outbox Pattern for Reliable Distributed Event Streaming
CREATE TABLE outbox_events (
    event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- PENDING, PUBLISHED, FAILED
    retry_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);
