"""Build the offline V2 dataset without collapsing distinct route points.

Units, source rows, labels, and time windows are inherited from the audited
dataset.  Each forecast point receives its own columns.  This script writes
only to the git-ignored ``data`` directory.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = DATA / "04_ml_dataset_training_eligible_v2_points.csv"
SPEC = DATA / "04_ml_v2_point_feature_spec.json"

POINTS = [
    "tokyo_port",
    "tokyo_bay_mouth",
    "uraga_channel",
    "sagami_north",
    "sagami_central",
    "oshima_north_okata",
    "oshima_west_motomachi",
    "atami_offshore",
    "ito_offshore",
    "inatori_offshore",
    "tateyama_offshore",
]
WEATHER = [
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
    "pressure_msl",
]
MARINE = [
    "wave_height",
    "wave_direction",
    "wave_period",
    "swell_wave_height",
    "swell_wave_direction",
    "swell_wave_period",
]


def finite(frame: pd.DataFrame, column: str) -> np.ndarray:
    return pd.to_numeric(frame[column], errors="coerce").dropna().to_numpy(float)


def circular_components(values: np.ndarray) -> tuple[float, float]:
    if not len(values):
        return np.nan, np.nan
    radians = np.deg2rad(values)
    return float(np.sin(radians).mean()), float(np.cos(radians).mean())


def value_at(frame: pd.DataFrame, timestamp: pd.Timestamp, column: str) -> float:
    values = finite(frame[frame.timestamp_jst == timestamp], column)
    return float(values[0]) if len(values) else np.nan


def point_features(
    point: str,
    frame: pd.DataFrame,
    departure: pd.Timestamp,
    arrival: pd.Timestamp,
    active: bool,
) -> dict[str, float]:
    prefix = f"point__{point}__"
    result: dict[str, float] = {f"{prefix}route_active": float(active)}
    if not active:
        return result

    journey = frame[(frame.timestamp_jst >= departure.floor("h")) & (frame.timestamp_jst <= arrival)]
    pre3 = frame[(frame.timestamp_jst >= departure - pd.Timedelta(hours=3)) & (frame.timestamp_jst <= departure)]
    threshold_window = frame[(frame.timestamp_jst >= departure - pd.Timedelta(hours=6)) & (frame.timestamp_jst <= arrival)]

    aggregations = {
        "wind_speed_10m_max": (journey, "wind_speed_10m", np.max),
        "wind_gusts_10m_max": (journey, "wind_gusts_10m", np.max),
        "pressure_msl_min": (journey, "pressure_msl", np.min),
        "wave_height_max": (journey, "wave_height", np.max),
        "wave_period_mean": (journey, "wave_period", np.mean),
        "swell_wave_height_max": (journey, "swell_wave_height", np.max),
        "swell_wave_period_mean": (journey, "swell_wave_period", np.mean),
        "pre3h_wind_gusts_10m_max": (pre3, "wind_gusts_10m", np.max),
        "pre3h_wave_height_max": (pre3, "wave_height", np.max),
    }
    for name, (window, variable, operation) in aggregations.items():
        values = finite(window, variable)
        result[f"{prefix}{name}"] = float(operation(values)) if len(values) else np.nan

    for variable in ("wind_direction_10m", "wave_direction", "swell_wave_direction"):
        sine, cosine = circular_components(finite(journey, variable))
        result[f"{prefix}{variable}_sin_mean"] = sine
        result[f"{prefix}{variable}_cos_mean"] = cosine

    current = departure.floor("h")
    for hours in (3, 6):
        previous = current - pd.Timedelta(hours=hours)
        for variable in ("wind_speed_10m", "wave_height"):
            now_value = value_at(frame, current, variable)
            old_value = value_at(frame, previous, variable)
            result[f"{prefix}change_{hours}h_{variable}"] = (
                now_value - old_value if pd.notna(now_value) and pd.notna(old_value) else np.nan
            )

    hourly = threshold_window.groupby("timestamp_jst")[["wind_speed_10m", "wave_height"]].max(numeric_only=True)
    result[f"{prefix}hours_wind_ge_10ms_pre6_to_arrival"] = float((hourly.wind_speed_10m >= 10).sum())
    result[f"{prefix}hours_wave_ge_2_5m_pre6_to_arrival"] = float((hourly.wave_height >= 2.5).sum())
    return result


def main() -> None:
    voyages = pd.read_csv(DATA / "03_ml_dataset_training_eligible.csv", encoding="utf-8-sig")
    voyages["scheduled_departure_jst"] = pd.to_datetime(voyages.scheduled_departure_jst)
    voyages["estimated_arrival_jst"] = pd.to_datetime(voyages.estimated_arrival_jst)
    weather = pd.read_csv(
        DATA / "02_weather_hourly_raw.csv",
        usecols=["location_id", "timestamp_jst", *WEATHER],
        parse_dates=["timestamp_jst"],
    )
    marine = pd.read_csv(
        DATA / "02_marine_hourly_raw.csv",
        usecols=["location_id", "timestamp_jst", *MARINE],
        parse_dates=["timestamp_jst"],
    )
    environment = (
        weather.merge(marine, on=["location_id", "timestamp_jst"], how="outer")
        .set_index(["location_id", "timestamp_jst"])
        .sort_index()
    )

    rows = []
    for index, voyage in voyages.iterrows():
        if index % 500 == 0:
            print(f"building V2 {index}/{len(voyages)}", flush=True)
        active_points = set(str(voyage.route_points).split("|"))
        start = voyage.scheduled_departure_jst - pd.Timedelta(hours=6)
        end = voyage.estimated_arrival_jst.ceil("h")
        try:
            voyage_block = environment.loc[(list(active_points), slice(start.floor("h"), end)), :].reset_index()
        except KeyError:
            voyage_block = pd.DataFrame(columns=["location_id", "timestamp_jst", *WEATHER, *MARINE])
        output = {"voyage_id": voyage.voyage_id}
        for point in POINTS:
            block = voyage_block[voyage_block.location_id == point]
            output.update(
                point_features(
                    point,
                    block,
                    voyage.scheduled_departure_jst,
                    voyage.estimated_arrival_jst,
                    point in active_points,
                )
            )
        rows.append(output)

    point_frame = pd.DataFrame(rows).set_index("voyage_id")
    result = voyages.set_index("voyage_id").join(point_frame, how="left", validate="one_to_one").reset_index()
    result.to_csv(OUT, index=False, encoding="utf-8-sig", date_format="%Y-%m-%d %H:%M:%S")

    feature_columns = [column for column in result.columns if column.startswith("point__")]
    missing_active = int(result[[column for column in feature_columns if column.endswith("route_active")]].isna().sum().sum())
    spec = {
        "version": "v2-point-1",
        "probability_meaning": "probability of weather/marine cancellation for the voyage",
        "source_rows": len(result),
        "points": POINTS,
        "point_feature_count": len(feature_columns),
        "route_active_missing": missing_active,
        "units": {
            "wind_speed_10m": "m/s",
            "wind_gusts_10m": "m/s",
            "pressure_msl": "hPa",
            "wave_height": "m",
            "wave_period": "s",
            "swell_wave_height": "m",
            "swell_wave_period": "s",
            "direction_components": "sin/cos of degrees",
            "threshold_duration": "integer hours",
        },
        "time_windows_jst": {
            "journey": "departure floor hour through estimated arrival",
            "pre3h": "departure minus 3 hours through departure",
            "change": "departure floor hour versus 3/6 hours earlier",
            "threshold": "departure minus 6 hours through estimated arrival",
        },
    }
    SPEC.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(spec, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
