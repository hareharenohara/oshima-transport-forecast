const journeyVariables: Array<[string, "scalar" | "direction"]> = [
  ["wind_speed_10m", "scalar"], ["wind_direction_10m", "direction"], ["wind_gusts_10m", "scalar"],
  ["pressure_msl", "scalar"], ["precipitation", "scalar"], ["cloud_cover", "scalar"],
  ["wave_height", "scalar"], ["wave_direction", "direction"], ["wave_period", "scalar"],
  ["wind_wave_height", "scalar"], ["wind_wave_direction", "direction"], ["wind_wave_period", "scalar"],
  ["swell_wave_height", "scalar"], ["swell_wave_direction", "direction"], ["swell_wave_period", "scalar"]
];
const windowVars = ["wind_speed_10m", "wind_gusts_10m", "wave_height", "swell_wave_height"];

export const NUMERIC_FEATURE_NAMES = [
  ...journeyVariables.flatMap(([v, kind]) => kind === "direction"
    ? [`journey_${v}_sin_mean`, `journey_${v}_cos_mean`]
    : [`journey_${v}_mean`, `journey_${v}_max`, `journey_${v}_min`]),
  ...["pre3h", "pre6h"].flatMap((w) => windowVars.flatMap((v) => [`${w}_${v}_mean`, `${w}_${v}_max`, `${w}_${v}_min`])),
  "change_3h_wind_speed_10m", "change_6h_wind_speed_10m", "change_3h_wave_height", "change_6h_wave_height",
  "hours_route_wind_ge_10ms_pre6_to_arrival", "hours_route_wave_ge_2_5m_pre6_to_arrival", "estimated_duration_minutes",
  "departure_month_sin", "departure_month_cos", "departure_hour_sin", "departure_hour_cos", "departure_weekend"
] as const;

export const CATEGORY_LEVELS = {
  ship_type: ["jet", "large"], direction: ["from_oshima", "to_oshima"],
  counterpart_terminal: ["久里浜", "伊東", "東京", "横浜", "熱海", "稲取", "館山"],
  voyage_number: ["1100", "1110", "1140", "1210", "1220", "1230", "1250", "1260", "1270", "1280", "1350", "1410", "1420", "1430", "1450", "2000", "2001", "2010", "2100", "2110", "2130", "2170", "2210", "2220", "2230", "2250", "2260", "2270", "2280", "2350", "2400", "2410", "2430", "2440", "2450", "3000", "3001", "3010", "__MISSING__"]
} as const;

export const MODEL_FEATURE_NAMES = [
  ...NUMERIC_FEATURE_NAMES,
  ...Object.entries(CATEGORY_LEVELS).flatMap(([key, values]) => values.map((value) => `${key}=${value}`))
];
