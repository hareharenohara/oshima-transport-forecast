export const FORECAST_POINTS = [
  { id: "tokyo_port", latitude: 35.619, longitude: 139.795 },
  { id: "tokyo_bay_mouth", latitude: 35.205, longitude: 139.735 },
  { id: "uraga_channel", latitude: 35.235, longitude: 139.725 },
  { id: "sagami_north", latitude: 35.18, longitude: 139.43 },
  { id: "sagami_central", latitude: 34.98, longitude: 139.42 },
  { id: "oshima_north_okata", latitude: 34.795, longitude: 139.39 },
  { id: "oshima_west_motomachi", latitude: 34.75, longitude: 139.35 },
  { id: "atami_offshore", latitude: 35.08, longitude: 139.105 },
  { id: "ito_offshore", latitude: 34.955, longitude: 139.145 },
  { id: "inatori_offshore", latitude: 34.785, longitude: 139.02 },
  { id: "tateyama_offshore", latitude: 34.955, longitude: 139.79 }
] as const;

export const ROUTE_POINTS: Record<string, readonly string[]> = {
  "東京": ["tokyo_port", "tokyo_bay_mouth", "uraga_channel", "sagami_north", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"],
  "横浜": ["tokyo_bay_mouth", "uraga_channel", "sagami_north", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"],
  "久里浜": ["uraga_channel", "sagami_north", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"],
  "熱海": ["atami_offshore", "sagami_north", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"],
  "伊東": ["ito_offshore", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"],
  "稲取": ["inatori_offshore", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"],
  "館山": ["tateyama_offshore", "sagami_central", "oshima_north_okata", "oshima_west_motomachi"]
};
