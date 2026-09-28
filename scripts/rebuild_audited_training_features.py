"""Rebuild the audited feature windows from the supplied hourly source data."""
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WEATHER_VARS = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "pressure_msl", "precipitation", "cloud_cover"]
MARINE_VARS = ["wave_height", "wave_direction", "wave_period", "wind_wave_height", "wind_wave_direction", "wind_wave_period", "swell_wave_height", "swell_wave_direction", "swell_wave_period"]
DIRECTION_VARS = {"wind_direction_10m", "wave_direction", "wind_wave_direction", "swell_wave_direction"}


def safe_stats(frame, prefix, variables):
    result = {}
    for variable in variables:
        values = pd.to_numeric(frame[variable], errors="coerce").dropna()
        if variable in DIRECTION_VARS:
            radians = np.deg2rad(values.to_numpy(float))
            result[f"{prefix}_{variable}_sin_mean"] = float(np.mean(np.sin(radians))) if len(radians) else np.nan
            result[f"{prefix}_{variable}_cos_mean"] = float(np.mean(np.cos(radians))) if len(radians) else np.nan
        else:
            result[f"{prefix}_{variable}_mean"] = float(values.mean()) if len(values) else np.nan
            result[f"{prefix}_{variable}_max"] = float(values.max()) if len(values) else np.nan
            result[f"{prefix}_{variable}_min"] = float(values.min()) if len(values) else np.nan
    return result


def main():
    voyages = pd.read_csv(DATA / "03_ml_dataset_training_eligible.csv", encoding="utf-8-sig")
    voyages["scheduled_departure_jst"] = pd.to_datetime(voyages["scheduled_departure_jst"])
    voyages["estimated_arrival_jst"] = pd.to_datetime(voyages["estimated_arrival_jst"])
    weather = pd.read_csv(DATA / "02_weather_hourly_raw.csv", usecols=["location_id", "timestamp_jst", *WEATHER_VARS], parse_dates=["timestamp_jst"])
    marine = pd.read_csv(DATA / "02_marine_hourly_raw.csv", usecols=["location_id", "timestamp_jst", *MARINE_VARS], parse_dates=["timestamp_jst"])
    env = weather.merge(marine, on=["location_id", "timestamp_jst"], how="outer").set_index(["location_id", "timestamp_jst"]).sort_index()

    feature_rows = []
    for number, row in voyages.iterrows():
        if number % 500 == 0:
            print(f"rebuilding {number}/{len(voyages)}", flush=True)
        departure, arrival = row.scheduled_departure_jst, row.estimated_arrival_jst
        locations = row.route_points.split("|")
        start = departure - pd.Timedelta(hours=6)
        try:
            block = env.loc[(locations, slice(start.floor("h"), arrival.ceil("h"))), :].reset_index()
        except KeyError:
            block = pd.DataFrame(columns=["timestamp_jst", *WEATHER_VARS, *MARINE_VARS])
        journey = block[(block.timestamp_jst >= departure.floor("h")) & (block.timestamp_jst <= arrival)]
        pre3 = block[(block.timestamp_jst >= departure - pd.Timedelta(hours=3)) & (block.timestamp_jst <= departure)]
        pre6 = block[(block.timestamp_jst >= departure - pd.Timedelta(hours=6)) & (block.timestamp_jst <= departure)]
        features = {"voyage_id": row.voyage_id}
        features.update(safe_stats(journey, "journey", WEATHER_VARS + MARINE_VARS))
        window_vars = ["wind_speed_10m", "wind_gusts_10m", "wave_height", "swell_wave_height"]
        features.update(safe_stats(pre3, "pre3h", window_vars))
        features.update(safe_stats(pre6, "pre6h", window_vars))
        hourly = block.groupby("timestamp_jst")[["wind_speed_10m", "wave_height"]].mean(numeric_only=True)
        current_time = departure.floor("h")
        for variable in ["wind_speed_10m", "wave_height"]:
            current = hourly[variable].get(current_time, np.nan)
            for hours in (3, 6):
                old = hourly[variable].get(current_time - pd.Timedelta(hours=hours), np.nan)
                features[f"change_{hours}h_{variable}"] = float(current - old) if pd.notna(current) and pd.notna(old) else np.nan
        threshold_block = block[(block.timestamp_jst >= start) & (block.timestamp_jst <= arrival)]
        hourly_max = threshold_block.groupby("timestamp_jst")[["wind_speed_10m", "wave_height"]].max(numeric_only=True)
        features["hours_route_wind_ge_10ms_pre6_to_arrival"] = int((hourly_max.wind_speed_10m >= 10).sum())
        features["hours_route_wave_ge_2_5m_pre6_to_arrival"] = int((hourly_max.wave_height >= 2.5).sum())
        feature_rows.append(features)

    rebuilt = pd.DataFrame(feature_rows).set_index("voyage_id")
    target = voyages.set_index("voyage_id")
    for column in rebuilt.columns:
        target[column] = rebuilt[column]
    output = DATA / "03_ml_dataset_training_eligible_audited.csv"
    target.reset_index().to_csv(output, index=False, encoding="utf-8-sig", date_format="%Y-%m-%d %H:%M:%S")
    print(output, flush=True)


if __name__ == "__main__":
    main()
