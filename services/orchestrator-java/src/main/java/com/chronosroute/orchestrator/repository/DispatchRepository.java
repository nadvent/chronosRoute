package com.chronosroute.orchestrator.repository;

import com.chronosroute.orchestrator.domain.Courier;
import com.chronosroute.orchestrator.domain.CourierStatus;
import com.chronosroute.orchestrator.domain.GeoPoint;
import com.chronosroute.orchestrator.domain.IdempotencyRecord;
import com.chronosroute.orchestrator.domain.OptimisticLockConflictException;
import com.chronosroute.orchestrator.domain.Order;
import com.chronosroute.orchestrator.domain.OrderStatus;
import com.chronosroute.orchestrator.domain.OutboxEvent;
import com.chronosroute.orchestrator.dto.OrderDtos.CourierSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.HubSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.OrderSnapshotDto;
import com.chronosroute.orchestrator.dto.OrderDtos.RoutePetalDto;
import com.chronosroute.orchestrator.dto.OrderDtos.RouteWaypointDto;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Repository;

/**
 * Transactional repository for orders, couriers, outbox events, and idempotency records.
 *
 * <p>Uses PostgreSQL {@code SELECT ... FOR UPDATE SKIP LOCKED} for lock-free concurrent worker
 * batch claiming and {@code @Version} optimistic locking for entity mutations. Uses
 * {@link ReentrantLock} per row for in-process concurrency testing so Virtual Threads never pin
 * OS carrier threads.
 */
@Repository
public class DispatchRepository {

    public static final String ENSURE_HUB_SQL = """
            INSERT INTO hubs (hub_id, name, location, capacity_orders_per_hour, created_at)
            VALUES (?, ?, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, 500, NOW())
            ON CONFLICT (hub_id) DO NOTHING
            """;

    public static final String INSERT_ORDER_SQL = """
            INSERT INTO orders (
                order_id, hub_id, courier_id, status, weight_kg,
                pickup_location, dropoff_location, dropoff_node,
                window_start, window_end, service_duration_seconds,
                created_at, updated_at, version
            ) VALUES (
                ?, ?, ?, ?::order_status, ?,
                ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
                ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
                ?, ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT (order_id) DO UPDATE SET
                status = EXCLUDED.status,
                courier_id = EXCLUDED.courier_id,
                updated_at = EXCLUDED.updated_at,
                version = EXCLUDED.version
            """;

    public static final String FIND_ORDER_BY_ID_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   dropoff_node, window_start, window_end, service_duration_seconds,
                   created_at, updated_at, version
            FROM orders
            WHERE order_id = ?
            """;

    public static final String INSERT_COURIER_SQL = """
            INSERT INTO couriers (
                courier_id, name, status, current_capacity_kg, max_capacity_kg,
                last_location, last_ping_at, shift_start, shift_end, created_at
            ) VALUES (
                ?, ?, ?::courier_status, ?, ?,
                ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
                ?, ?, ?, ?
            )
            ON CONFLICT (courier_id) DO UPDATE SET
                name = EXCLUDED.name,
                status = EXCLUDED.status,
                current_capacity_kg = EXCLUDED.current_capacity_kg,
                max_capacity_kg = EXCLUDED.max_capacity_kg,
                last_location = EXCLUDED.last_location,
                last_ping_at = EXCLUDED.last_ping_at,
                shift_start = EXCLUDED.shift_start,
                shift_end = EXCLUDED.shift_end
            """;

    public static final String FIND_COURIER_BY_ID_SQL = """
            SELECT courier_id, name, status, current_capacity_kg, max_capacity_kg,
                   ST_Y(last_location::geometry) AS lat, ST_X(last_location::geometry) AS lon,
                   last_ping_at, shift_start, shift_end, created_at
            FROM couriers
            WHERE courier_id = ?
            """;

    public static final String FIND_AVAILABLE_COURIERS_SQL = """
            SELECT courier_id, name, status, current_capacity_kg, max_capacity_kg,
                   ST_Y(last_location::geometry) AS lat, ST_X(last_location::geometry) AS lon,
                   last_ping_at, shift_start, shift_end, created_at
            FROM couriers
            WHERE status IN ('IDLE', 'ASSIGNED')
            ORDER BY created_at ASC
            LIMIT ?
            """;

    public static final String CLAIM_PENDING_ORDERS_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   dropoff_node, window_start, window_end, service_duration_seconds,
                   created_at, updated_at, version
            FROM orders
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
            """;

    public static final String CLAIM_PENDING_OUTBOX_SQL = """
            SELECT event_id, aggregate_type, aggregate_id, event_type, payload::text AS payload,
                   status, retry_count, created_at, published_at
            FROM outbox_events
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
            """;

    public static final String INSERT_OUTBOX_EVENT_SQL = """
            INSERT INTO outbox_events (
                event_id, aggregate_type, aggregate_id, event_type, payload,
                status, retry_count, created_at, published_at
            ) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
            ON CONFLICT (event_id) DO NOTHING
            """;

    public static final String MARK_OUTBOX_PUBLISHED_SQL = """
            UPDATE outbox_events
            SET status = 'PUBLISHED', published_at = ?
            WHERE event_id = ?
            """;

    public static final String UPDATE_ORDER_STATUS_OPTIMISTIC_SQL = """
            UPDATE orders
            SET status = ?::order_status, courier_id = ?, updated_at = NOW(), version = version + 1
            WHERE order_id = ? AND version = ?
            """;

    public static final String UPDATE_COURIER_CAPACITY_OPTIMISTIC_SQL = """
            UPDATE couriers
            SET status = ?::courier_status, current_capacity_kg = ?, last_ping_at = NOW()
            WHERE courier_id = ?
            """;

    public static final String INSERT_IDEMPOTENCY_KEY_SQL = """
            INSERT INTO idempotency_keys (
                key_id, aggregate_type, aggregate_id, response_code, response_payload, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?::jsonb, NOW(), ?)
            ON CONFLICT (key_id) DO NOTHING
            """;

    public static final String FIND_IDEMPOTENCY_KEY_SQL = """
            SELECT key_id, aggregate_type, aggregate_id, response_code,
                   response_payload::text AS response_payload, created_at, expires_at
            FROM idempotency_keys
            WHERE key_id = ? AND expires_at > NOW()
            """;

    public static final String FIND_AVAILABLE_COURIERS_DWITHIN_SQL = """
            SELECT courier_id, name, status, current_capacity_kg, max_capacity_kg,
                   ST_Y(last_location::geometry) AS lat, ST_X(last_location::geometry) AS lon,
                   last_ping_at, shift_start, shift_end, created_at
            FROM couriers
            WHERE status = 'IDLE'
              AND ST_DWithin(last_location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)
            ORDER BY last_location <-> ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography
            LIMIT ?
            """;

    public static final String FIND_SNAPSHOT_HUBS_SQL = """
            SELECT hub_id, name,
                   ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS lon,
                   capacity_orders_per_hour
            FROM hubs
            ORDER BY created_at ASC, name ASC
            """;

    public static final String FIND_HUB_SERVICE_ZONES_GEOJSON_SQL = """
            SELECT hub_id, name, capacity_orders_per_hour,
                   ST_AsGeoJSON(ST_Buffer(location, 4500)::geometry) AS zone_geojson
            FROM hubs
            ORDER BY created_at ASC, name ASC
            """;

    public static final String FIND_SNAPSHOT_COURIERS_SQL = """
            SELECT c.courier_id, c.name, c.status,
                   c.current_capacity_kg, c.max_capacity_kg,
                   ST_Y(c.last_location::geometry) AS lat,
                   ST_X(c.last_location::geometry) AS lon,
                   c.last_ping_at, c.shift_start, c.shift_end,
                   t.speed_mps, t.heading_deg, t.battery_pct
            FROM couriers c
            LEFT JOIN LATERAL (
                SELECT speed_mps, heading_deg, battery_pct
                FROM courier_telemetry ct
                WHERE ct.courier_id = c.courier_id
                ORDER BY ct.recorded_at DESC
                LIMIT 1
            ) t ON TRUE
            ORDER BY CASE WHEN c.status = 'OFFLINE' THEN 1 ELSE 0 END ASC,
                     c.last_ping_at DESC,
                     c.created_at ASC
            LIMIT ?
            """;

    public static final String FIND_ACTIVE_COURIER_ORDERS_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   dropoff_node, window_start, window_end, service_duration_seconds,
                   created_at, updated_at, version
            FROM orders
            WHERE courier_id IS NOT NULL
              AND status IN ('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')
            ORDER BY window_start ASC, created_at ASC
            """;

    public static final String FIND_SNAPSHOT_ACTIVE_ORDERS_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   window_start, window_end, service_duration_seconds, version
            FROM orders
            WHERE status IN ('PENDING', 'BATCHING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT')
            ORDER BY CASE status
                         WHEN 'PENDING' THEN 0
                         WHEN 'BATCHING' THEN 1
                         WHEN 'ASSIGNED' THEN 2
                         WHEN 'PICKED_UP' THEN 3
                         WHEN 'IN_TRANSIT' THEN 4
                         ELSE 5
                     END ASC,
                     updated_at DESC,
                     created_at DESC
            LIMIT ?
            """;

    public static final String FIND_SNAPSHOT_RECENT_ORDERS_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   window_start, window_end, service_duration_seconds, version
            FROM orders
            WHERE status IN ('DELIVERED', 'CANCELLED')
            ORDER BY updated_at DESC, created_at DESC
            LIMIT ?
            """;

    public static final String CLAIM_PENDING_ORDERS_BY_HUB_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   dropoff_node, window_start, window_end, service_duration_seconds,
                   created_at, updated_at, version
            FROM orders
            WHERE hub_id = ? AND status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
            """;

    public static final String FIND_ASSIGNED_ORDERS_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   dropoff_node, window_start, window_end, service_duration_seconds,
                   created_at, updated_at, version
            FROM orders
            WHERE status = 'ASSIGNED'
            ORDER BY window_start ASC, created_at ASC
            LIMIT ?
            """;

    public static final String FIND_ASSIGNED_ORDERS_BY_HUB_SQL = """
            SELECT order_id, hub_id, courier_id, status, weight_kg,
                   ST_Y(pickup_location::geometry) AS pickup_lat,
                   ST_X(pickup_location::geometry) AS pickup_lon,
                   ST_Y(dropoff_location::geometry) AS dropoff_lat,
                   ST_X(dropoff_location::geometry) AS dropoff_lon,
                   dropoff_node, window_start, window_end, service_duration_seconds,
                   created_at, updated_at, version
            FROM orders
            WHERE hub_id = ? AND status = 'ASSIGNED'
            ORDER BY window_start ASC, created_at ASC
            LIMIT ?
            """;

    public static final String DELETE_ROUTE_BY_COURIER_SQL =
            "DELETE FROM routes WHERE courier_id = ?";

    public static final String INSERT_ROUTE_WITH_GEOM_SQL = """
            INSERT INTO routes (
                route_id, courier_id, hub_id, total_distance_meters,
                total_duration_seconds, route_geometry, scheduled_date, created_at
            ) VALUES (?, ?, ?, ?, ?, ST_GeomFromText(?, 4326)::geography, CURRENT_DATE, NOW())
            """;

    public static final String INSERT_ROUTE_NO_GEOM_SQL = """
            INSERT INTO routes (
                route_id, courier_id, hub_id, total_distance_meters,
                total_duration_seconds, route_geometry, scheduled_date, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, CURRENT_DATE, NOW())
            """;

    public static final String FIND_ACTIVE_ROUTES_SQL = """
            SELECT DISTINCT ON (r.courier_id)
                   r.courier_id, r.hub_id, c.name AS courier_name,
                   r.total_distance_meters, r.total_duration_seconds,
                   c.current_capacity_kg, c.max_capacity_kg,
                   ST_Y(c.last_location::geometry) AS courier_lat,
                   ST_X(c.last_location::geometry) AS courier_lon,
                   ST_AsGeoJSON(r.route_geometry::geometry) AS line_geojson
            FROM routes r
            JOIN couriers c ON c.courier_id = r.courier_id
            ORDER BY r.courier_id, r.created_at DESC
            """;

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE_REF = new TypeReference<>() {};

    private final DataSource dataSource;
    private final Map<UUID, HubSnapshotDto> hubs = new ConcurrentHashMap<>();
    private final Map<UUID, Order> orders = new ConcurrentHashMap<>();
    private final Map<UUID, ReentrantLock> orderRowLocks = new ConcurrentHashMap<>();
    private final Map<UUID, Courier> couriers = new ConcurrentHashMap<>();
    private final Map<UUID, ReentrantLock> courierRowLocks = new ConcurrentHashMap<>();
    private final Map<UUID, RoutePetalDto> activeRoutePetals = new ConcurrentHashMap<>();
    private final Map<UUID, OutboxEvent> outboxEvents = new ConcurrentHashMap<>();
    private final Map<UUID, ReentrantLock> outboxRowLocks = new ConcurrentHashMap<>();
    private final Map<String, IdempotencyRecord> idempotencyKeys = new ConcurrentHashMap<>();
    private final ReentrantLock idempotencyLock = new ReentrantLock();

    private final ThreadLocal<Boolean> transactionActive = ThreadLocal.withInitial(() -> false);
    private final ThreadLocal<List<ReentrantLock>> heldRowLocks =
            ThreadLocal.withInitial(ArrayList::new);

    public DispatchRepository() {
        this(null);
    }

    @Autowired
    public DispatchRepository(@Autowired(required = false) DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public void beginTransaction() {
        if (Boolean.TRUE.equals(transactionActive.get())) {
            throw new IllegalStateException("Database transaction is already active on current thread");
        }
        transactionActive.set(true);
    }

    public void commitTransaction() {
        if (!Boolean.TRUE.equals(transactionActive.get())) {
            throw new IllegalStateException("No active database transaction to commit");
        }
        releaseAllHeldRowLocks();
        transactionActive.set(false);
    }

    public void rollbackTransaction() {
        releaseAllHeldRowLocks();
        transactionActive.set(false);
    }

    public boolean isTransactionActive() {
        return Boolean.TRUE.equals(transactionActive.get());
    }

    private void releaseAllHeldRowLocks() {
        List<ReentrantLock> locks = heldRowLocks.get();
        for (int i = locks.size() - 1; i >= 0; i--) {
            ReentrantLock lock = locks.get(i);
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
        locks.clear();
    }

    public Order saveNewOrder(Order order) {
        ReentrantLock rowLock = orderRowLocks.computeIfAbsent(order.getOrderId(), k -> new ReentrantLock());
        rowLock.lock();
        try {
            Order copy = order.copy();
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection()) {
                    try (PreparedStatement hubPs = conn.prepareStatement(ENSURE_HUB_SQL)) {
                        hubPs.setObject(1, copy.getHubId());
                        hubPs.setString(2, "Hub-" + copy.getHubId().toString().substring(0, 8));
                        hubPs.setDouble(3, copy.getPickupLocation().longitude());
                        hubPs.setDouble(4, copy.getPickupLocation().latitude());
                        hubPs.executeUpdate();
                    }
                    try (PreparedStatement ps = conn.prepareStatement(INSERT_ORDER_SQL)) {
                        ps.setObject(1, copy.getOrderId());
                        ps.setObject(2, copy.getHubId());
                        ps.setObject(3, copy.getCourierId());
                        ps.setString(4, copy.getStatus().name());
                        ps.setBigDecimal(5, copy.getWeightKg());
                        ps.setDouble(6, copy.getPickupLocation().longitude());
                        ps.setDouble(7, copy.getPickupLocation().latitude());
                        ps.setDouble(8, copy.getDropoffLocation().longitude());
                        ps.setDouble(9, copy.getDropoffLocation().latitude());
                        ps.setLong(10, copy.getDropoffNode());
                        ps.setTimestamp(11, Timestamp.from(copy.getWindowStart()));
                        ps.setTimestamp(12, Timestamp.from(copy.getWindowEnd()));
                        ps.setInt(13, copy.getServiceDurationSeconds());
                        ps.setTimestamp(14, Timestamp.from(copy.getCreatedAt()));
                        ps.setTimestamp(15, Timestamp.from(copy.getUpdatedAt()));
                        ps.setInt(16, copy.getVersion());
                        ps.executeUpdate();
                    }
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException("Failed to persist new order via JDBC", e);
                    }
                }
            }
            hubs.putIfAbsent(
                    copy.getHubId(),
                    new HubSnapshotDto(
                            copy.getHubId(),
                            "Hub-" + copy.getHubId().toString().substring(0, 8),
                            copy.getPickupLocation().latitude(),
                            copy.getPickupLocation().longitude(),
                            500));
            orders.put(copy.getOrderId(), copy);
            return copy.copy();
        } finally {
            rowLock.unlock();
        }
    }

    public Courier saveCourier(Courier courier) {
        ReentrantLock rowLock =
                courierRowLocks.computeIfAbsent(courier.getCourierId(), k -> new ReentrantLock());
        rowLock.lock();
        try {
            Courier copy = courier.copy();
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection();
                        PreparedStatement ps = conn.prepareStatement(INSERT_COURIER_SQL)) {
                    ps.setObject(1, copy.getCourierId());
                    ps.setString(2, copy.getName());
                    ps.setString(3, copy.getStatus().name());
                    ps.setBigDecimal(4, copy.getCurrentCapacityKg());
                    ps.setBigDecimal(5, copy.getMaxCapacityKg());
                    ps.setDouble(6, copy.getLastLocation().longitude());
                    ps.setDouble(7, copy.getLastLocation().latitude());
                    ps.setTimestamp(8, Timestamp.from(copy.getLastPingAt()));
                    ps.setTimestamp(9, Timestamp.from(copy.getShiftStart()));
                    ps.setTimestamp(10, Timestamp.from(copy.getShiftEnd()));
                    ps.setTimestamp(11, Timestamp.from(copy.getCreatedAt()));
                    ps.executeUpdate();
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException("Failed to persist courier via JDBC", e);
                    }
                }
            }
            couriers.put(copy.getCourierId(), copy);
            return copy.copy();
        } finally {
            rowLock.unlock();
        }
    }

    public Optional<Order> findOrderById(UUID orderId) {
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(FIND_ORDER_BY_ID_SQL)) {
                ps.setObject(1, orderId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        Order foundJdbc = mapResultSetToOrder(rs);
                        orders.put(orderId, foundJdbc.copy());
                        return Optional.of(foundJdbc);
                    }
                    orders.remove(orderId);
                    return Optional.empty();
                }
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to query order by ID via JDBC", e);
                }
            }
        }
        Order found = orders.get(orderId);
        return found == null ? Optional.empty() : Optional.of(found.copy());
    }

    public Optional<Courier> findCourierById(UUID courierId) {
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(FIND_COURIER_BY_ID_SQL)) {
                ps.setObject(1, courierId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        Courier inMem = couriers.get(courierId);
                        Courier foundJdbc = mapResultSetToCourier(rs, inMem);
                        couriers.put(courierId, foundJdbc.copy());
                        return Optional.of(foundJdbc);
                    }
                    couriers.remove(courierId);
                    return Optional.empty();
                }
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to query courier by ID via JDBC", e);
                }
            }
        }
        Courier found = couriers.get(courierId);
        return found == null ? Optional.empty() : Optional.of(found.copy());
    }

    public List<Courier> findAvailableCouriers(int limit) {
        if (limit <= 0) {
            return List.of();
        }
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(FIND_AVAILABLE_COURIERS_SQL)) {
                ps.setInt(1, limit);
                List<Courier> availableJdbc = new ArrayList<>();
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        UUID cid = UUID.fromString(rs.getString("courier_id"));
                        Courier inMem = couriers.get(cid);
                        Courier mapped = mapResultSetToCourier(rs, inMem);
                        couriers.put(cid, mapped.copy());
                        availableJdbc.add(mapped);
                    }
                }
                return availableJdbc;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to find available couriers via JDBC", e);
                }
            }
        }
        List<Courier> available = new ArrayList<>();
        for (Courier c : couriers.values()) {
            if (c.getStatus().isAvailableForDispatch()) {
                available.add(c.copy());
                if (available.size() >= limit) {
                    break;
                }
            }
        }
        return available;
    }

    /**
     * Claims up to {@code limit} {@code PENDING} orders using {@code SELECT ... FOR UPDATE SKIP LOCKED}
     * semantics and transitions them to {@code BATCHING} inside the caller's short transaction.
     */
    public List<Order> claimPendingOrdersSkipLocked(int limit) {
        if (limit <= 0) {
            return List.of();
        }
        if (dataSource != null) {
            try {
                return claimPendingOrdersJdbc(limit);
            } catch (IllegalStateException ex) {
                if (!(ex.getCause() instanceof SQLException sqlEx)
                        || !isConnectionUnavailable(sqlEx)) {
                    throw ex;
                }
            }
        }

        List<Order> candidates = new ArrayList<>(orders.values());
        candidates.sort(
                Comparator.comparing(Order::getCreatedAt)
                        .thenComparing(o -> o.getOrderId().toString()));

        List<Order> claimed = new ArrayList<>(Math.min(limit, candidates.size()));
        for (Order candidate : candidates) {
            if (claimed.size() >= limit) {
                break;
            }
            if (candidate.getStatus() != OrderStatus.PENDING) {
                continue;
            }
            UUID orderId = candidate.getOrderId();
            ReentrantLock rowLock = orderRowLocks.computeIfAbsent(orderId, k -> new ReentrantLock());
            // SKIP LOCKED semantics: if another worker holds the row lock, skip immediately without waiting
            if (!rowLock.tryLock()) {
                continue;
            }
            try {
                Order current = orders.get(orderId);
                if (current != null && current.getStatus() == OrderStatus.PENDING) {
                    Order updated = current.copy();
                    updated.transitionTo(OrderStatus.BATCHING);
                    updated.incrementVersion();
                    orders.put(orderId, updated);
                    claimed.add(updated.copy());
                    if (isTransactionActive()) {
                        heldRowLocks.get().add(rowLock);
                    } else {
                        rowLock.unlock();
                    }
                } else {
                    rowLock.unlock();
                }
            } catch (RuntimeException ex) {
                if (rowLock.isHeldByCurrentThread()) {
                    rowLock.unlock();
                }
                throw ex;
            }
        }
        return claimed;
    }

    private List<Order> claimPendingOrdersJdbc(int limit) {
        List<Order> claimed = new ArrayList<>();
        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(false);
            try (PreparedStatement ps = conn.prepareStatement(CLAIM_PENDING_ORDERS_SQL)) {
                ps.setInt(1, limit);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        Order order = mapResultSetToOrder(rs);
                        order.transitionTo(OrderStatus.BATCHING);
                        try (PreparedStatement ups =
                                conn.prepareStatement(UPDATE_ORDER_STATUS_OPTIMISTIC_SQL)) {
                            ups.setString(1, order.getStatus().name());
                            ups.setObject(2, order.getCourierId());
                            ups.setObject(3, order.getOrderId());
                            ups.setInt(4, order.getVersion());
                            int updated = ups.executeUpdate();
                            if (updated == 1) {
                                order.incrementVersion();
                                orders.put(order.getOrderId(), order.copy());
                                claimed.add(order);
                            }
                        }
                    }
                }
            }
            conn.commit();
        } catch (SQLException e) {
            throw new IllegalStateException("Failed to claim pending orders via SKIP LOCKED", e);
        }
        return claimed;
    }

    /**
     * Updates an {@link Order} verifying its {@code @Version} optimistic lock matches
     * {@code expectedVersion}.
     */
    public Order updateOrderWithOptimisticLock(Order updatedOrder, int expectedVersion) {
        UUID orderId = updatedOrder.getOrderId();
        ReentrantLock rowLock = orderRowLocks.computeIfAbsent(orderId, k -> new ReentrantLock());
        rowLock.lock();
        try {
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection();
                        PreparedStatement ups =
                                conn.prepareStatement(UPDATE_ORDER_STATUS_OPTIMISTIC_SQL)) {
                    ups.setString(1, updatedOrder.getStatus().name());
                    ups.setObject(2, updatedOrder.getCourierId());
                    ups.setObject(3, orderId);
                    ups.setInt(4, expectedVersion);
                    int rowsUpdated = ups.executeUpdate();
                    if (rowsUpdated == 1) {
                        Order next = updatedOrder.copy();
                        if (next.getVersion() == expectedVersion) {
                            next.incrementVersion();
                        }
                        orders.put(orderId, next);
                        return next.copy();
                    }
                    try (PreparedStatement checkPs = conn.prepareStatement(
                            "SELECT version FROM orders WHERE order_id = ?")) {
                        checkPs.setObject(1, orderId);
                        try (ResultSet rs = checkPs.executeQuery()) {
                            if (rs.next()) {
                                int actualVersion = rs.getInt("version");
                                throw new OptimisticLockConflictException(
                                        "Order", orderId.toString(), expectedVersion, actualVersion);
                            }
                        }
                    }
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException(
                                "Failed to update order with optimistic lock via JDBC", e);
                    }
                }
            }

            Order existing = orders.get(orderId);
            if (existing == null) {
                throw new IllegalArgumentException("Order not found: " + orderId);
            }
            if (existing.getVersion() != expectedVersion) {
                throw new OptimisticLockConflictException(
                        "Order", orderId.toString(), expectedVersion, existing.getVersion());
            }
            Order next = updatedOrder.copy();
            next.incrementVersion();
            orders.put(orderId, next);
            return next.copy();
        } finally {
            rowLock.unlock();
        }
    }

    /**
     * Updates a {@link Courier} verifying its {@code @Version} optimistic lock matches
     * {@code expectedVersion}.
     */
    public Courier updateCourierWithOptimisticLock(Courier updatedCourier, int expectedVersion) {
        UUID courierId = updatedCourier.getCourierId();
        ReentrantLock rowLock = courierRowLocks.computeIfAbsent(courierId, k -> new ReentrantLock());
        rowLock.lock();
        try {
            Courier existing = couriers.get(courierId);
            if (existing != null && existing.getVersion() != expectedVersion) {
                throw new OptimisticLockConflictException(
                        "Courier", courierId.toString(), expectedVersion, existing.getVersion());
            }
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection();
                        PreparedStatement ups =
                                conn.prepareStatement(UPDATE_COURIER_CAPACITY_OPTIMISTIC_SQL)) {
                    ups.setString(1, updatedCourier.getStatus().name());
                    ups.setBigDecimal(2, updatedCourier.getCurrentCapacityKg());
                    ups.setObject(3, courierId);
                    int rows = ups.executeUpdate();
                    if (rows == 0 && existing == null) {
                        throw new IllegalArgumentException("Courier not found: " + courierId);
                    }
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException(
                                "Failed to update courier with optimistic lock via JDBC", e);
                    }
                }
            } else if (existing == null) {
                throw new IllegalArgumentException("Courier not found: " + courierId);
            }
            Courier next = updatedCourier.copy();
            next.incrementVersion();
            couriers.put(courierId, next);
            return next.copy();
        } finally {
            rowLock.unlock();
        }
    }

    public OutboxEvent insertOutboxEvent(OutboxEvent event) {
        ReentrantLock rowLock = outboxRowLocks.computeIfAbsent(event.getEventId(), k -> new ReentrantLock());
        rowLock.lock();
        try {
            OutboxEvent copy = event.copy();
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection();
                        PreparedStatement ps = conn.prepareStatement(INSERT_OUTBOX_EVENT_SQL)) {
                    ps.setObject(1, copy.getEventId());
                    ps.setString(2, copy.getAggregateType());
                    ps.setString(3, copy.getAggregateId());
                    ps.setString(4, copy.getEventType());
                    ps.setString(5, copy.getPayload());
                    ps.setString(6, copy.getStatus());
                    ps.setInt(7, copy.getRetryCount());
                    ps.setTimestamp(8, Timestamp.from(copy.getCreatedAt()));
                    if (copy.getPublishedAt() != null) {
                        ps.setTimestamp(9, Timestamp.from(copy.getPublishedAt()));
                    } else {
                        ps.setNull(9, Types.TIMESTAMP_WITH_TIMEZONE);
                    }
                    ps.executeUpdate();
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException("Failed to insert outbox event via JDBC", e);
                    }
                }
            }
            outboxEvents.put(copy.getEventId(), copy);
            return copy.copy();
        } finally {
            rowLock.unlock();
        }
    }

    /**
     * Claims up to {@code limit} uncommitted {@code PENDING} outbox events using
     * {@code SELECT ... FOR UPDATE SKIP LOCKED}.
     */
    public List<OutboxEvent> claimPendingOutboxEventsSkipLocked(int limit) {
        if (limit <= 0) {
            return List.of();
        }
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection()) {
                conn.setAutoCommit(false);
                List<OutboxEvent> claimedJdbc = new ArrayList<>();
                try (PreparedStatement ps = conn.prepareStatement(CLAIM_PENDING_OUTBOX_SQL)) {
                    ps.setInt(1, limit);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            Timestamp pubTs = rs.getTimestamp("published_at");
                            OutboxEvent evt = new OutboxEvent(
                                    UUID.fromString(rs.getString("event_id")),
                                    rs.getString("aggregate_type"),
                                    rs.getString("aggregate_id"),
                                    rs.getString("event_type"),
                                    rs.getString("payload"),
                                    rs.getString("status"),
                                    rs.getInt("retry_count"),
                                    rs.getTimestamp("created_at").toInstant(),
                                    pubTs != null ? pubTs.toInstant() : null,
                                    0);
                            outboxEvents.put(evt.getEventId(), evt.copy());
                            claimedJdbc.add(evt);
                        }
                    }
                }
                conn.commit();
                return claimedJdbc;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException(
                            "Failed to claim pending outbox events via SKIP LOCKED", e);
                }
            }
        }

        List<OutboxEvent> candidates = new ArrayList<>(outboxEvents.values());
        candidates.sort(
                Comparator.comparing(OutboxEvent::getCreatedAt)
                        .thenComparing(e -> e.getEventId().toString()));

        List<OutboxEvent> claimed = new ArrayList<>();
        for (OutboxEvent candidate : candidates) {
            if (claimed.size() >= limit) {
                break;
            }
            if (!OutboxEvent.STATUS_PENDING.equals(candidate.getStatus())) {
                continue;
            }
            ReentrantLock rowLock =
                    outboxRowLocks.computeIfAbsent(candidate.getEventId(), k -> new ReentrantLock());
            if (!rowLock.tryLock()) {
                continue;
            }
            try {
                OutboxEvent current = outboxEvents.get(candidate.getEventId());
                if (current != null && OutboxEvent.STATUS_PENDING.equals(current.getStatus())) {
                    claimed.add(current.copy());
                    if (isTransactionActive()) {
                        heldRowLocks.get().add(rowLock);
                    } else {
                        rowLock.unlock();
                    }
                } else {
                    rowLock.unlock();
                }
            } catch (RuntimeException ex) {
                if (rowLock.isHeldByCurrentThread()) {
                    rowLock.unlock();
                }
                throw ex;
            }
        }
        return claimed;
    }

    public void markOutboxEventPublished(UUID eventId, Instant publishedAt) {
        ReentrantLock rowLock = outboxRowLocks.computeIfAbsent(eventId, k -> new ReentrantLock());
        rowLock.lock();
        try {
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection();
                        PreparedStatement ps = conn.prepareStatement(MARK_OUTBOX_PUBLISHED_SQL)) {
                    ps.setTimestamp(1, Timestamp.from(publishedAt));
                    ps.setObject(2, eventId);
                    ps.executeUpdate();
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException(
                                "Failed to mark outbox event published via JDBC", e);
                    }
                }
            }
            OutboxEvent existing = outboxEvents.get(eventId);
            if (existing != null) {
                OutboxEvent copy = existing.copy();
                copy.markPublished(publishedAt);
                outboxEvents.put(eventId, copy);
            }
        } finally {
            rowLock.unlock();
        }
    }

    public List<OutboxEvent> findAllOutboxEvents() {
        List<OutboxEvent> list = new ArrayList<>();
        for (OutboxEvent e : outboxEvents.values()) {
            list.add(e.copy());
        }
        return list;
    }

    public Optional<IdempotencyRecord> findIdempotencyRecord(String keyId) {
        if (keyId == null || keyId.isBlank()) {
            return Optional.empty();
        }
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(FIND_IDEMPOTENCY_KEY_SQL)) {
                ps.setString(1, keyId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) {
                        IdempotencyRecord rec = new IdempotencyRecord(
                                rs.getString("key_id"),
                                rs.getString("aggregate_type"),
                                rs.getString("aggregate_id"),
                                rs.getInt("response_code"),
                                rs.getString("response_payload"),
                                rs.getTimestamp("created_at").toInstant(),
                                rs.getTimestamp("expires_at").toInstant(),
                                0);
                        idempotencyKeys.put(keyId, rec);
                        return Optional.of(rec);
                    }
                    idempotencyKeys.remove(keyId);
                    return Optional.empty();
                }
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to find idempotency record via JDBC", e);
                }
            }
        }
        idempotencyLock.lock();
        try {
            IdempotencyRecord rec = idempotencyKeys.get(keyId);
            if (rec == null || rec.isExpired(Instant.now())) {
                return Optional.empty();
            }
            return Optional.of(rec);
        } finally {
            idempotencyLock.unlock();
        }
    }

    /**
     * Atomically inserts an {@link IdempotencyRecord} if not already present
     * ({@code INSERT ... ON CONFLICT (key_id) DO NOTHING}).
     *
     * @return {@code true} if newly inserted, {@code false} if key already existed
     */
    public boolean saveIdempotencyRecordIfAbsent(IdempotencyRecord record) {
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(INSERT_IDEMPOTENCY_KEY_SQL)) {
                ps.setString(1, record.getKeyId());
                ps.setString(2, record.getAggregateType());
                ps.setString(3, record.getAggregateId());
                ps.setInt(4, record.getResponseCode());
                ps.setString(5, record.getResponsePayload());
                ps.setTimestamp(6, Timestamp.from(record.getExpiresAt()));
                boolean inserted = ps.executeUpdate() == 1;
                if (inserted) {
                    idempotencyKeys.put(record.getKeyId(), record);
                }
                return inserted;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to insert idempotency key", e);
                }
            }
        }
        idempotencyLock.lock();
        try {
            IdempotencyRecord existing = idempotencyKeys.get(record.getKeyId());
            if (existing != null && !existing.isExpired(Instant.now())) {
                return false;
            }
            idempotencyKeys.put(record.getKeyId(), record);
            return true;
        } finally {
            idempotencyLock.unlock();
        }
    }

    public DataSource getDataSource() {
        return dataSource;
    }

    public void saveHub(HubSnapshotDto hub) {
        if (hub != null) {
            hubs.put(hub.hubId(), hub);
        }
    }

    public void clearCachedSeedState() {
        hubs.clear();
        orders.clear();
        couriers.clear();
        activeRoutePetals.clear();
        outboxEvents.clear();
        idempotencyKeys.clear();
    }

    public List<Order> claimPendingOrdersByHubSkipLocked(UUID hubId, int limit) {
        if (hubId == null) {
            return claimPendingOrdersSkipLocked(limit);
        }
        if (limit <= 0) {
            return List.of();
        }
        if (dataSource != null) {
            try {
                List<Order> claimed = new ArrayList<>();
                try (Connection conn = dataSource.getConnection()) {
                    conn.setAutoCommit(false);
                    try (PreparedStatement ps = conn.prepareStatement(CLAIM_PENDING_ORDERS_BY_HUB_SQL)) {
                        ps.setObject(1, hubId);
                        ps.setInt(2, limit);
                        try (ResultSet rs = ps.executeQuery()) {
                            while (rs.next()) {
                                Order order = mapResultSetToOrder(rs);
                                order.transitionTo(OrderStatus.BATCHING);
                                try (PreparedStatement ups =
                                        conn.prepareStatement(UPDATE_ORDER_STATUS_OPTIMISTIC_SQL)) {
                                    ups.setString(1, order.getStatus().name());
                                    ups.setObject(2, order.getCourierId());
                                    ups.setObject(3, order.getOrderId());
                                    ups.setInt(4, order.getVersion());
                                    if (ups.executeUpdate() == 1) {
                                        order.incrementVersion();
                                        orders.put(order.getOrderId(), order.copy());
                                        claimed.add(order);
                                    }
                                }
                            }
                        }
                    }
                    conn.commit();
                    return claimed;
                }
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException(
                            "Failed to claim pending orders for hub via SKIP LOCKED", e);
                }
            }
        }

        List<Order> candidates = new ArrayList<>(orders.values());
        candidates.sort(
                Comparator.comparing(Order::getCreatedAt)
                        .thenComparing(o -> o.getOrderId().toString()));
        List<Order> claimed = new ArrayList<>();
        for (Order candidate : candidates) {
            if (claimed.size() >= limit) {
                break;
            }
            if (candidate.getStatus() != OrderStatus.PENDING
                    || !hubId.equals(candidate.getHubId())) {
                continue;
            }
            UUID orderId = candidate.getOrderId();
            ReentrantLock rowLock = orderRowLocks.computeIfAbsent(orderId, k -> new ReentrantLock());
            if (!rowLock.tryLock()) {
                continue;
            }
            try {
                Order current = orders.get(orderId);
                if (current != null && current.getStatus() == OrderStatus.PENDING) {
                    Order updated = current.copy();
                    updated.transitionTo(OrderStatus.BATCHING);
                    updated.incrementVersion();
                    orders.put(orderId, updated);
                    claimed.add(updated.copy());
                    if (isTransactionActive()) {
                        heldRowLocks.get().add(rowLock);
                    } else {
                        rowLock.unlock();
                    }
                } else {
                    rowLock.unlock();
                }
            } catch (RuntimeException ex) {
                if (rowLock.isHeldByCurrentThread()) {
                    rowLock.unlock();
                }
                throw ex;
            }
        }
        return claimed;
    }

    public List<Order> findAssignedOrders(UUID hubId, int limit) {
        if (limit <= 0) {
            return List.of();
        }
        if (dataSource != null) {
            String sql = hubId != null ? FIND_ASSIGNED_ORDERS_BY_HUB_SQL : FIND_ASSIGNED_ORDERS_SQL;
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(sql)) {
                if (hubId != null) {
                    ps.setObject(1, hubId);
                    ps.setInt(2, limit);
                } else {
                    ps.setInt(1, limit);
                }
                List<Order> result = new ArrayList<>();
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        Order order = mapResultSetToOrder(rs);
                        orders.put(order.getOrderId(), order.copy());
                        result.add(order);
                    }
                }
                return result;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to query assigned orders via JDBC", e);
                }
            }
        }

        List<Order> result = new ArrayList<>();
        for (Order o : orders.values()) {
            if (o.getStatus() == OrderStatus.ASSIGNED
                    && (hubId == null || hubId.equals(o.getHubId()))) {
                result.add(o.copy());
            }
        }
        result.sort(Comparator.comparing(Order::getWindowStart).thenComparing(Order::getCreatedAt));
        return result.size() > limit ? result.subList(0, limit) : result;
    }

    public List<HubSnapshotDto> findSnapshotHubs() {
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(FIND_SNAPSHOT_HUBS_SQL);
                    ResultSet rs = ps.executeQuery()) {
                List<HubSnapshotDto> dbHubs = new ArrayList<>();
                while (rs.next()) {
                    HubSnapshotDto dto = new HubSnapshotDto(
                            UUID.fromString(rs.getString("hub_id")),
                            rs.getString("name"),
                            rs.getDouble("lat"),
                            rs.getDouble("lon"),
                            rs.getInt("capacity_orders_per_hour"));
                    dbHubs.add(dto);
                }
                hubs.clear();
                for (HubSnapshotDto h : dbHubs) {
                    hubs.put(h.hubId(), h);
                }
                return dbHubs;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to query snapshot hubs via JDBC", e);
                }
            }
        }
        if (!hubs.isEmpty()) {
            List<HubSnapshotDto> list = new ArrayList<>(hubs.values());
            list.sort(Comparator.comparing(HubSnapshotDto::name));
            return list;
        }
        Map<UUID, HubSnapshotDto> derived = new LinkedHashMap<>();
        for (Order o : orders.values()) {
            derived.computeIfAbsent(
                    o.getHubId(),
                    id -> new HubSnapshotDto(
                            id,
                            "Hub-" + id.toString().substring(0, 8),
                            o.getPickupLocation().latitude(),
                            o.getPickupLocation().longitude(),
                            500));
        }
        return new ArrayList<>(derived.values());
    }

    public Map<String, Object> findHubServiceZonesGeoJson() {
        List<Map<String, Object>> features = new ArrayList<>();
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection();
                    PreparedStatement ps = conn.prepareStatement(FIND_HUB_SERVICE_ZONES_GEOJSON_SQL);
                    ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    UUID hubId = UUID.fromString(rs.getString("hub_id"));
                    String name = rs.getString("name");
                    int capacity = rs.getInt("capacity_orders_per_hour");
                    String zoneJson = rs.getString("zone_geojson");
                    Map<String, Object> geometry = parseJsonObject(zoneJson);
                    if (geometry != null) {
                        features.add(buildZoneFeature(hubId, name, capacity, geometry));
                    }
                }
                return buildFeatureCollection(features);
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to compute hub service zones GeoJSON", e);
                }
            }
        }

        for (HubSnapshotDto hub : findSnapshotHubs()) {
            features.add(buildZoneFeature(
                    hub.hubId(),
                    hub.name(),
                    hub.capacityOrdersPerHour(),
                    buildCirclePolygonGeometry(hub.lat(), hub.lon(), 4500.0)));
        }
        return buildFeatureCollection(features);
    }

    public List<CourierSnapshotDto> findSnapshotCouriers(int limit) {
        int effectiveLimit = limit <= 0 ? 200 : limit;
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection()) {
                Map<UUID, List<UUID>> assignedByCourier = loadActiveOrderIdsByCourier(conn);
                try (PreparedStatement ps = conn.prepareStatement(FIND_SNAPSHOT_COURIERS_SQL)) {
                    ps.setInt(1, effectiveLimit);
                    List<CourierSnapshotDto> result = new ArrayList<>();
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            UUID courierId = UUID.fromString(rs.getString("courier_id"));
                            List<UUID> activeIds = assignedByCourier.get(courierId);
                            if (activeIds == null) {
                                RoutePetalDto petal = activeRoutePetals.get(courierId);
                                if (petal != null && !petal.waypoints().isEmpty()) {
                                    activeIds = petal.waypoints().stream()
                                            .map(RouteWaypointDto::orderId)
                                            .toList();
                                } else {
                                    activeIds = List.of();
                                }
                            }
                            Object speedObj = rs.getObject("speed_mps");
                            Object headingObj = rs.getObject("heading_deg");
                            Object batteryObj = rs.getObject("battery_pct");
                            double speedMps = speedObj instanceof Number n ? n.doubleValue() : 0.0;
                            double headingDeg = headingObj instanceof Number n ? n.doubleValue() : 0.0;
                            int batteryPct = batteryObj instanceof Number n ? n.intValue() : 100;
                            result.add(new CourierSnapshotDto(
                                    courierId,
                                    rs.getString("name"),
                                    CourierStatus.valueOf(rs.getString("status")),
                                    rs.getDouble("lat"),
                                    rs.getDouble("lon"),
                                    headingDeg,
                                    speedMps,
                                    batteryPct,
                                    rs.getBigDecimal("current_capacity_kg"),
                                    rs.getBigDecimal("max_capacity_kg"),
                                    rs.getTimestamp("last_ping_at").toInstant(),
                                    rs.getTimestamp("shift_start").toInstant(),
                                    rs.getTimestamp("shift_end").toInstant(),
                                    activeIds));
                        }
                    }
                    return result;
                }
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to query snapshot couriers via JDBC", e);
                }
            }
        }

        List<CourierSnapshotDto> result = new ArrayList<>();
        for (Courier c : couriers.values()) {
            if (result.size() >= effectiveLimit) {
                break;
            }
            result.add(new CourierSnapshotDto(
                    c.getCourierId(),
                    c.getName(),
                    c.getStatus(),
                    c.getLastLocation().latitude(),
                    c.getLastLocation().longitude(),
                    0.0,
                    0.0,
                    100,
                    c.getCurrentCapacityKg(),
                    c.getMaxCapacityKg(),
                    c.getLastPingAt(),
                    c.getShiftStart(),
                    c.getShiftEnd(),
                    c.getActiveRouteOrderIds()));
        }
        return result;
    }

    public List<OrderSnapshotDto> findSnapshotOrders(int limit) {
        int effectiveLimit = limit <= 0 ? 200 : limit;
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection()) {
                List<OrderSnapshotDto> result = new ArrayList<>();
                try (PreparedStatement ps = conn.prepareStatement(FIND_SNAPSHOT_ACTIVE_ORDERS_SQL)) {
                    ps.setInt(1, effectiveLimit);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            result.add(mapResultSetToOrderSnapshot(rs));
                        }
                    }
                }
                int remaining = effectiveLimit - result.size();
                if (remaining > 0) {
                    try (PreparedStatement ps = conn.prepareStatement(FIND_SNAPSHOT_RECENT_ORDERS_SQL)) {
                        ps.setInt(1, remaining);
                        try (ResultSet rs = ps.executeQuery()) {
                            while (rs.next()) {
                                result.add(mapResultSetToOrderSnapshot(rs));
                            }
                        }
                    }
                }
                return result;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to query snapshot orders via JDBC", e);
                }
            }
        }

        List<Order> sorted = new ArrayList<>(orders.values());
        sorted.sort(
                Comparator.comparingInt((Order o) -> snapshotStatusPriority(o.getStatus()))
                        .thenComparing(Order::getUpdatedAt, Comparator.reverseOrder())
                        .thenComparing(Order::getCreatedAt, Comparator.reverseOrder()));
        int count = Math.min(effectiveLimit, sorted.size());
        List<OrderSnapshotDto> result = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            Order o = sorted.get(i);
            result.add(new OrderSnapshotDto(
                    o.getOrderId(),
                    o.getHubId(),
                    o.getCourierId(),
                    o.getStatus(),
                    o.getWeightKg(),
                    o.getPickupLocation().latitude(),
                    o.getPickupLocation().longitude(),
                    o.getDropoffLocation().latitude(),
                    o.getDropoffLocation().longitude(),
                    o.getWindowStart(),
                    o.getWindowEnd(),
                    o.getServiceDurationSeconds(),
                    o.getVersion()));
        }
        return result;
    }

    public RoutePetalDto saveOrReplaceRoute(
            UUID courierId,
            UUID hubId,
            long distM,
            long durSec,
            List<List<Double>> pathCoords) {
        Objects.requireNonNull(courierId, "courierId must not be null");
        RoutePetalDto existing = activeRoutePetals.get(courierId);
        Courier courier = findCourierById(courierId).orElse(null);

        UUID resolvedHubId = hubId != null ? hubId : (existing != null ? existing.hubId() : null);
        String courierName = courier != null
                ? courier.getName()
                : (existing != null ? existing.courierName() : "Courier-" + courierId.toString().substring(0, 8));
        double maxCap = courier != null
                ? courier.getMaxCapacityKg().doubleValue()
                : (existing != null ? existing.maxCapacityKg() : 30.0);
        double capUsed = courier != null
                ? Math.max(0.0, courier.getMaxCapacityKg().subtract(courier.getCurrentCapacityKg()).doubleValue())
                : (existing != null ? existing.capacityUsedKg() : 0.0);
        String poly = existing != null ? existing.encodedPolyline() : "";
        List<RouteWaypointDto> waypoints = existing != null ? existing.waypoints() : List.of();
        List<List<Double>> coords = pathCoords != null ? pathCoords : List.of();

        RoutePetalDto petal = new RoutePetalDto(
                courierId,
                resolvedHubId,
                courierName,
                distM,
                durSec,
                capUsed,
                maxCap,
                poly,
                waypoints,
                coords);
        saveOrReplaceRoute(petal);
        return petal;
    }

    public void saveOrReplaceRoute(RoutePetalDto petal) {
        Objects.requireNonNull(petal, "petal must not be null");
        ReentrantLock rowLock =
                courierRowLocks.computeIfAbsent(petal.courierId(), k -> new ReentrantLock());
        rowLock.lock();
        try {
            activeRoutePetals.put(petal.courierId(), petal);
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection()) {
                    UUID effectiveHubId = resolveHubIdForRoute(conn, petal.hubId(), petal.pathCoords());
                    if (effectiveHubId != null) {
                        conn.setAutoCommit(false);
                        try {
                            try (PreparedStatement delPs = conn.prepareStatement(DELETE_ROUTE_BY_COURIER_SQL)) {
                                delPs.setObject(1, petal.courierId());
                                delPs.executeUpdate();
                            }
                            String wkt = buildLineStringWkt(petal.pathCoords());
                            String insertSql = wkt != null ? INSERT_ROUTE_WITH_GEOM_SQL : INSERT_ROUTE_NO_GEOM_SQL;
                            try (PreparedStatement insPs = conn.prepareStatement(insertSql)) {
                                insPs.setObject(1, UUID.randomUUID());
                                insPs.setObject(2, petal.courierId());
                                insPs.setObject(3, effectiveHubId);
                                insPs.setInt(4, (int) Math.min(Integer.MAX_VALUE, Math.max(0L, petal.totalDistanceMeters())));
                                insPs.setInt(5, (int) Math.min(Integer.MAX_VALUE, Math.max(0L, petal.totalDurationSeconds())));
                                if (wkt != null) {
                                    insPs.setString(6, wkt);
                                }
                                insPs.executeUpdate();
                            }
                            conn.commit();
                        } catch (SQLException innerEx) {
                            try {
                                conn.rollback();
                            } catch (SQLException ignored) {
                            }
                            throw innerEx;
                        }
                    }
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException("Failed to persist route petal via JDBC", e);
                    }
                }
            }
        } finally {
            rowLock.unlock();
        }
    }

    public void deleteRouteForCourier(UUID courierId) {
        if (courierId == null) {
            return;
        }
        ReentrantLock rowLock = courierRowLocks.computeIfAbsent(courierId, k -> new ReentrantLock());
        rowLock.lock();
        try {
            activeRoutePetals.remove(courierId);
            if (dataSource != null) {
                try (Connection conn = dataSource.getConnection();
                        PreparedStatement ps = conn.prepareStatement(DELETE_ROUTE_BY_COURIER_SQL)) {
                    ps.setObject(1, courierId);
                    ps.executeUpdate();
                } catch (SQLException e) {
                    if (!isConnectionUnavailable(e)) {
                        throw new IllegalStateException("Failed to delete courier route via JDBC", e);
                    }
                }
            }
        } finally {
            rowLock.unlock();
        }
    }

    public List<RoutePetalDto> getActiveRoutePetals() {
        if (dataSource != null) {
            try (Connection conn = dataSource.getConnection()) {
                Map<UUID, List<Order>> assignedOrdersByCourier = loadActiveOrdersByCourier(conn);
                List<RoutePetalDto> dbPetals = new ArrayList<>();
                Set<UUID> seenCouriers = new HashSet<>();

                try (PreparedStatement ps = conn.prepareStatement(FIND_ACTIVE_ROUTES_SQL);
                        ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        UUID courierId = UUID.fromString(rs.getString("courier_id"));
                        UUID hubId = UUID.fromString(rs.getString("hub_id"));
                        long distM = rs.getLong("total_distance_meters");
                        long durSec = rs.getLong("total_duration_seconds");
                        seenCouriers.add(courierId);

                        RoutePetalDto cached = activeRoutePetals.get(courierId);
                        if (cached != null
                                && cached.totalDistanceMeters() == distM
                                && cached.totalDurationSeconds() == durSec) {
                            dbPetals.add(cached);
                            continue;
                        }

                        List<Order> courierOrders =
                                assignedOrdersByCourier.getOrDefault(courierId, List.of());
                        List<RouteWaypointDto> waypoints = buildWaypointsFromOrders(courierOrders);
                        List<List<Double>> pathCoords = parseLineStringCoords(rs.getString("line_geojson"));
                        if (pathCoords.isEmpty()) {
                            double cLat = rs.getDouble("courier_lat");
                            double cLon = rs.getDouble("courier_lon");
                            pathCoords = buildPathCoordsFromWaypoints(cLon, cLat, waypoints);
                        }
                        BigDecimal maxCap = rs.getBigDecimal("max_capacity_kg");
                        BigDecimal curCap = rs.getBigDecimal("current_capacity_kg");
                        double usedKg = Math.max(0.0, maxCap.subtract(curCap).doubleValue());
                        RoutePetalDto rebuilt = new RoutePetalDto(
                                courierId,
                                hubId,
                                rs.getString("courier_name"),
                                distM,
                                durSec,
                                usedKg,
                                maxCap.doubleValue(),
                                "",
                                waypoints,
                                pathCoords);
                        activeRoutePetals.put(courierId, rebuilt);
                        dbPetals.add(rebuilt);
                    }
                }

                // Prune any cached petals whose route/orders no longer exist in DB (e.g. after re-seed)
                activeRoutePetals.keySet().removeIf(
                        cid -> !seenCouriers.contains(cid) && !assignedOrdersByCourier.containsKey(cid));

                if (dbPetals.isEmpty() && !assignedOrdersByCourier.isEmpty()) {
                    for (Map.Entry<UUID, List<Order>> entry : assignedOrdersByCourier.entrySet()) {
                        UUID cid = entry.getKey();
                        List<Order> list = entry.getValue();
                        if (!list.isEmpty()) {
                            Courier c = findCourierById(cid).orElse(null);
                            List<RouteWaypointDto> waypoints = buildWaypointsFromOrders(list);
                            double startLon = c != null ? c.getLastLocation().longitude() : list.get(0).getPickupLocation().longitude();
                            double startLat = c != null ? c.getLastLocation().latitude() : list.get(0).getPickupLocation().latitude();
                            List<List<Double>> coords = buildPathCoordsFromWaypoints(startLon, startLat, waypoints);
                            double usedKg = list.stream().mapToDouble(o -> o.getWeightKg().doubleValue()).sum();
                            double maxKg = c != null ? c.getMaxCapacityKg().doubleValue() : 30.0;
                            RoutePetalDto derived = new RoutePetalDto(
                                    cid,
                                    list.get(0).getHubId(),
                                    c != null ? c.getName() : "Courier-" + cid.toString().substring(0, 8),
                                    0L,
                                    0L,
                                    usedKg,
                                    maxKg,
                                    "",
                                    waypoints,
                                    coords);
                            activeRoutePetals.put(cid, derived);
                            dbPetals.add(derived);
                        }
                    }
                }

                dbPetals.sort(Comparator.comparing(RoutePetalDto::courierName));
                return dbPetals;
            } catch (SQLException e) {
                if (!isConnectionUnavailable(e)) {
                    throw new IllegalStateException("Failed to load active route petals via JDBC", e);
                }
            }
        }

        List<RoutePetalDto> list = new ArrayList<>(activeRoutePetals.values());
        list.sort(Comparator.comparing(RoutePetalDto::courierName));
        return list;
    }

    public double measurePostgisLatencyMs() {
        if (dataSource == null) {
            return 0.0;
        }
        long startNs = System.nanoTime();
        try (Connection conn = dataSource.getConnection();
                PreparedStatement ps = conn.prepareStatement("SELECT 1");
                ResultSet rs = ps.executeQuery()) {
            if (rs.next()) {
                long elapsedNs = System.nanoTime() - startNs;
                return Math.round((elapsedNs / 1_000_000.0) * 100.0) / 100.0;
            }
        } catch (SQLException e) {
            if (!isConnectionUnavailable(e)) {
                throw new IllegalStateException("Failed to measure PostGIS latency", e);
            }
        }
        return 0.0;
    }

    private UUID resolveHubIdForRoute(Connection conn, UUID preferredHubId, List<List<Double>> pathCoords)
            throws SQLException {
        if (preferredHubId != null) {
            double lon = 0.0;
            double lat = 0.0;
            if (pathCoords != null && !pathCoords.isEmpty() && pathCoords.get(0).size() >= 2) {
                lon = pathCoords.get(0).get(0);
                lat = pathCoords.get(0).get(1);
            }
            try (PreparedStatement hubPs = conn.prepareStatement(ENSURE_HUB_SQL)) {
                hubPs.setObject(1, preferredHubId);
                hubPs.setString(2, "Hub-" + preferredHubId.toString().substring(0, 8));
                hubPs.setDouble(3, lon);
                hubPs.setDouble(4, lat);
                hubPs.executeUpdate();
            }
            return preferredHubId;
        }
        try (PreparedStatement ps = conn.prepareStatement("SELECT hub_id FROM hubs LIMIT 1");
                ResultSet rs = ps.executeQuery()) {
            if (rs.next()) {
                return UUID.fromString(rs.getString("hub_id"));
            }
        }
        return null;
    }

    private static Map<UUID, List<UUID>> loadActiveOrderIdsByCourier(Connection conn) throws SQLException {
        Map<UUID, List<UUID>> map = new HashMap<>();
        try (PreparedStatement ps = conn.prepareStatement(FIND_ACTIVE_COURIER_ORDERS_SQL);
                ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                String cidStr = rs.getString("courier_id");
                if (cidStr != null) {
                    UUID cid = UUID.fromString(cidStr);
                    UUID oid = UUID.fromString(rs.getString("order_id"));
                    map.computeIfAbsent(cid, k -> new ArrayList<>()).add(oid);
                }
            }
        }
        return map;
    }

    private static Map<UUID, List<Order>> loadActiveOrdersByCourier(Connection conn) throws SQLException {
        Map<UUID, List<Order>> map = new HashMap<>();
        try (PreparedStatement ps = conn.prepareStatement(FIND_ACTIVE_COURIER_ORDERS_SQL);
                ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                Order order = mapResultSetToOrder(rs);
                if (order.getCourierId() != null) {
                    map.computeIfAbsent(order.getCourierId(), k -> new ArrayList<>()).add(order);
                }
            }
        }
        return map;
    }

    private static List<RouteWaypointDto> buildWaypointsFromOrders(List<Order> assignedOrders) {
        List<RouteWaypointDto> waypoints = new ArrayList<>(assignedOrders.size());
        long load = 0L;
        for (Order o : assignedOrders) {
            load += Math.max(1L, o.getWeightKg().longValue());
            long wStart = o.getWindowStart().getEpochSecond();
            long wEnd = o.getWindowEnd().getEpochSecond();
            waypoints.add(new RouteWaypointDto(
                    o.getOrderId(),
                    o.getDropoffLocation().latitude(),
                    o.getDropoffLocation().longitude(),
                    wStart,
                    wStart + o.getServiceDurationSeconds(),
                    Math.max(0L, wEnd - wStart),
                    load,
                    o.getWeightKg(),
                    wStart,
                    wEnd));
        }
        return waypoints;
    }

    private static List<List<Double>> buildPathCoordsFromWaypoints(
            double startLon, double startLat, List<RouteWaypointDto> waypoints) {
        List<List<Double>> coords = new ArrayList<>(waypoints.size() + 1);
        coords.add(List.of(startLon, startLat));
        for (RouteWaypointDto wp : waypoints) {
            coords.add(List.of(wp.lon(), wp.lat()));
        }
        return coords;
    }

    private static String buildLineStringWkt(List<List<Double>> pathCoords) {
        if (pathCoords == null || pathCoords.size() < 2) {
            return null;
        }
        StringBuilder sb = new StringBuilder("LINESTRING(");
        int valid = 0;
        for (List<Double> pt : pathCoords) {
            if (pt == null || pt.size() < 2) {
                continue;
            }
            if (valid > 0) {
                sb.append(", ");
            }
            sb.append(String.format(Locale.ROOT, "%.6f %.6f", pt.get(0), pt.get(1)));
            valid++;
        }
        if (valid < 2) {
            return null;
        }
        sb.append(')');
        return sb.toString();
    }

    private static List<List<Double>> parseLineStringCoords(String geoJson) {
        Map<String, Object> parsed = parseJsonObject(geoJson);
        if (parsed == null) {
            return List.of();
        }
        Object rawCoords = parsed.get("coordinates");
        if (!(rawCoords instanceof List<?> outer)) {
            return List.of();
        }
        List<List<Double>> coords = new ArrayList<>(outer.size());
        for (Object item : outer) {
            if (item instanceof List<?> pt && pt.size() >= 2
                    && pt.get(0) instanceof Number lon && pt.get(1) instanceof Number lat) {
                coords.add(List.of(lon.doubleValue(), lat.doubleValue()));
            }
        }
        return coords;
    }

    private static Map<String, Object> parseJsonObject(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return OBJECT_MAPPER.readValue(json, MAP_TYPE_REF);
        } catch (Exception e) {
            return null;
        }
    }

    private static Map<String, Object> buildZoneFeature(
            UUID hubId, String name, int capacity, Map<String, Object> geometry) {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("hubId", hubId.toString());
        props.put("name", name);
        props.put("capacityOrdersPerHour", capacity);
        props.put("radiusMeters", 4500);

        Map<String, Object> feature = new LinkedHashMap<>();
        feature.put("type", "Feature");
        feature.put("id", hubId.toString());
        feature.put("properties", props);
        feature.put("geometry", geometry);
        return feature;
    }

    private static Map<String, Object> buildFeatureCollection(List<Map<String, Object>> features) {
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("features", features);
        return fc;
    }

    private static Map<String, Object> buildCirclePolygonGeometry(
            double centerLat, double centerLon, double radiusMeters) {
        final int segments = 24;
        double dLat = (radiusMeters / 6371000.0) * (180.0 / Math.PI);
        double dLon = dLat / Math.max(0.1, Math.cos(Math.toRadians(centerLat)));
        List<List<Double>> ring = new ArrayList<>(segments + 1);
        for (int i = 0; i <= segments; i++) {
            double theta = 2.0 * Math.PI * (i % segments) / segments;
            double lon = centerLon + dLon * Math.cos(theta);
            double lat = centerLat + dLat * Math.sin(theta);
            ring.add(List.of(lon, lat));
        }
        Map<String, Object> geometry = new LinkedHashMap<>();
        geometry.put("type", "Polygon");
        geometry.put("coordinates", List.of(ring));
        return geometry;
    }

    private static int snapshotStatusPriority(OrderStatus status) {
        return switch (status) {
            case PENDING -> 0;
            case BATCHING -> 1;
            case ASSIGNED -> 2;
            case PICKED_UP -> 3;
            case IN_TRANSIT -> 4;
            default -> 5;
        };
    }

    private static OrderSnapshotDto mapResultSetToOrderSnapshot(ResultSet rs) throws SQLException {
        String cidStr = rs.getString("courier_id");
        return new OrderSnapshotDto(
                UUID.fromString(rs.getString("order_id")),
                UUID.fromString(rs.getString("hub_id")),
                cidStr != null ? UUID.fromString(cidStr) : null,
                OrderStatus.valueOf(rs.getString("status")),
                rs.getBigDecimal("weight_kg"),
                rs.getDouble("pickup_lat"),
                rs.getDouble("pickup_lon"),
                rs.getDouble("dropoff_lat"),
                rs.getDouble("dropoff_lon"),
                rs.getTimestamp("window_start").toInstant(),
                rs.getTimestamp("window_end").toInstant(),
                rs.getInt("service_duration_seconds"),
                rs.getInt("version"));
    }

    private static Order mapResultSetToOrder(ResultSet rs) throws SQLException {
        String cidStr = rs.getString("courier_id");
        return new Order(
                UUID.fromString(rs.getString("order_id")),
                UUID.fromString(rs.getString("hub_id")),
                cidStr != null ? UUID.fromString(cidStr) : null,
                OrderStatus.valueOf(rs.getString("status")),
                rs.getBigDecimal("weight_kg"),
                new GeoPoint(rs.getDouble("pickup_lat"), rs.getDouble("pickup_lon")),
                new GeoPoint(rs.getDouble("dropoff_lat"), rs.getDouble("dropoff_lon")),
                rs.getLong("dropoff_node"),
                rs.getTimestamp("window_start").toInstant(),
                rs.getTimestamp("window_end").toInstant(),
                rs.getInt("service_duration_seconds"),
                rs.getTimestamp("created_at").toInstant(),
                rs.getTimestamp("updated_at").toInstant(),
                rs.getInt("version"));
    }

    private static Courier mapResultSetToCourier(ResultSet rs, Courier inMem) throws SQLException {
        return new Courier(
                UUID.fromString(rs.getString("courier_id")),
                rs.getString("name"),
                CourierStatus.valueOf(rs.getString("status")),
                rs.getBigDecimal("current_capacity_kg"),
                rs.getBigDecimal("max_capacity_kg"),
                new GeoPoint(rs.getDouble("lat"), rs.getDouble("lon")),
                rs.getTimestamp("last_ping_at").toInstant(),
                rs.getTimestamp("shift_start").toInstant(),
                rs.getTimestamp("shift_end").toInstant(),
                rs.getTimestamp("created_at").toInstant(),
                inMem != null ? inMem.getVersion() : 0,
                inMem != null ? inMem.getActiveRouteOrderIds() : List.of(),
                inMem != null ? inMem.getActiveEncodedPolyline() : "");
    }

    private static boolean isConnectionUnavailable(SQLException e) {
        String state = e.getSQLState();
        return state != null && state.startsWith("08");
    }
}
