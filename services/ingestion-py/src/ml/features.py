"""
Spatio-Temporal Feature Engineering (`[HUMAN-OWNED]`).

Provides vectorized cyclical `(sin, cos)` encodings for `hour_of_day` (period 24)
and `heading_deg` (period 360), spherical Haversine distance and forward bearing,
and weather severity interaction terms producing `[N, 8]` float32 feature matrices
for the travel-time residual ONNX model.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import ArrayLike, NDArray

EARTH_RADIUS_KM: float = 6371.0088
FEATURE_DIM: int = 8
FEATURE_NAMES: tuple[str, ...] = (
    "hour_sin",
    "hour_cos",
    "heading_sin",
    "heading_cos",
    "haversine_km",
    "precipitation_mm",
    "wind_speed_kmh",
    "weather_severity_interaction",
)


def cyclical_encode(
    values: ArrayLike,
    period: float,
) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
    """
    Encode periodic scalar/array `values` onto the unit circle `(sin, cos)`:
        sin_val = sin(2 * pi * values / period)
        cos_val = cos(2 * pi * values / period)
    """
    if period <= 0.0:
        raise ValueError("period must be strictly positive")
    arr = np.asarray(values, dtype=np.float64)
    angles = (2.0 * np.pi * arr) / float(period)
    sin_part = np.sin(angles).astype(np.float32)
    cos_part = np.cos(angles).astype(np.float32)
    return sin_part, cos_part


def spherical_haversine_km(
    lat1: ArrayLike,
    lon1: ArrayLike,
    lat2: ArrayLike,
    lon2: ArrayLike,
) -> NDArray[np.float32]:
    """
    Compute great-circle distance in kilometers between WGS84 coordinates using
    the spherical Haversine formula.
    """
    phi1 = np.radians(np.asarray(lat1, dtype=np.float64))
    phi2 = np.radians(np.asarray(lat2, dtype=np.float64))
    dphi = np.radians(np.asarray(lat2, dtype=np.float64) - np.asarray(lat1, dtype=np.float64))
    dlambda = np.radians(np.asarray(lon2, dtype=np.float64) - np.asarray(lon1, dtype=np.float64))

    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * (np.sin(dlambda / 2.0) ** 2)
    a = np.clip(a, 0.0, 1.0)
    c = 2.0 * np.arctan2(np.sqrt(a), np.sqrt(1.0 - a))
    return (EARTH_RADIUS_KM * c).astype(np.float32)


def initial_bearing_deg(
    lat1: ArrayLike,
    lon1: ArrayLike,
    lat2: ArrayLike,
    lon2: ArrayLike,
) -> NDArray[np.float32]:
    """
    Compute initial forward azimuth (compass bearing in `[0, 360)`) between two WGS84 points.
    """
    phi1 = np.radians(np.asarray(lat1, dtype=np.float64))
    phi2 = np.radians(np.asarray(lat2, dtype=np.float64))
    dlambda = np.radians(np.asarray(lon2, dtype=np.float64) - np.asarray(lon1, dtype=np.float64))

    y = np.sin(dlambda) * np.cos(phi2)
    x = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlambda)
    theta = np.degrees(np.arctan2(y, x))
    bearing = np.mod(theta + 360.0, 360.0)
    return bearing.astype(np.float32)


def compute_weather_interaction(
    precipitation_mm: ArrayLike,
    wind_speed_kmh: ArrayLike,
) -> NDArray[np.float32]:
    """
    Compute nonlinear weather severity interaction term:
        log1p(max(0, precipitation_mm)) * (1.0 + max(0, wind_speed_kmh) / 50.0)
    """
    precip = np.maximum(0.0, np.asarray(precipitation_mm, dtype=np.float64))
    wind = np.maximum(0.0, np.asarray(wind_speed_kmh, dtype=np.float64))
    interaction = np.log1p(precip) * (1.0 + wind / 50.0)
    return interaction.astype(np.float32)


def build_feature_matrix(
    hour_of_day: ArrayLike,
    heading_deg: ArrayLike | None = None,
    origin_lat: ArrayLike = 37.7749,
    origin_lon: ArrayLike = -122.4194,
    dest_lat: ArrayLike = 37.7849,
    dest_lon: ArrayLike = -122.4094,
    precipitation_mm: ArrayLike = 0.0,
    wind_speed_kmh: ArrayLike = 0.0,
) -> NDArray[np.float32]:
    """
    Build an `[N, 8]` contiguous `float32` feature matrix ready for ONNX inference.

    Columns:
        0: hour_sin
        1: hour_cos
        2: heading_sin
        3: heading_cos
        4: haversine_km
        5: precipitation_mm
        6: wind_speed_kmh
        7: weather_severity_interaction
    """
    dist_km = spherical_haversine_km(origin_lat, origin_lon, dest_lat, dest_lon)
    if heading_deg is None:
        heading_arr = initial_bearing_deg(origin_lat, origin_lon, dest_lat, dest_lon)
    else:
        heading_arr = np.asarray(heading_deg, dtype=np.float32)

    hour_sin, hour_cos = cyclical_encode(hour_of_day, period=24.0)
    head_sin, head_cos = cyclical_encode(heading_arr, period=360.0)
    precip_arr = np.maximum(0.0, np.asarray(precipitation_mm, dtype=np.float32))
    wind_arr = np.maximum(0.0, np.asarray(wind_speed_kmh, dtype=np.float32))
    interaction = compute_weather_interaction(precip_arr, wind_arr)

    broadcast_arrays = np.broadcast_arrays(
        hour_sin,
        hour_cos,
        head_sin,
        head_cos,
        dist_km,
        precip_arr,
        wind_arr,
        interaction,
    )
    stacked = np.stack([a.astype(np.float32).reshape(-1) for a in broadcast_arrays], axis=1)
    return np.ascontiguousarray(stacked, dtype=np.float32)
