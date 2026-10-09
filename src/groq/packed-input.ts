// Transport only: compactJudgmentInput remains the source of judgment values.
export const PACKED_PHASES = ["d", "r", "a", "c3", "c6"] as const;
export const WEATHER_FIELDS = [
  ["wind_speed_10m", "m/s"], ["wind_direction_10m", "°"], ["wind_gusts_10m", "m/s"],
  ["precipitation", "mm"], ["pressure_msl", "hPa"]
] as const;
export const MARINE_FIELDS = [
  ["wave_height", "m"], ["wave_direction", "°"], ["wave_period", "s"],
  ["wind_wave_height", "m"], ["wind_wave_direction", "°"], ["wind_wave_period", "s"],
  ["swell_wave_height", "m"], ["swell_wave_direction", "°"], ["swell_wave_period", "s"]
] as const;

export const PACKED_INPUT_RULE = "入力のdefinitionsは全便共通の定義。w/seaの各行は[モデル番号,数値表]で、数値表はphasesの順、各行の数値はweather/marineの項目順。nullは欠損で0ではない。d=出発、r=航路、a=到着、c3/c6=元の3/6時間変化。単位は定義の通り。省略された便IDは外側のserviceId、出発/到着時刻はs.scheduledDepartureJst/s.scheduledArrivalJstを参照。各便の時間・方向・モデルを混同しない。";

export function packJudgmentInputs(items: Array<{ serviceId: string; input: unknown }>) {
  const models: string[] = [];
  const packRows = (value: unknown, fields: readonly (readonly [string, string])[]) => {
    if (!Array.isArray(value)) return value;
    return value.map((row: Record<string, unknown>) => {
      if (typeof row.m !== "string" || !row.m) throw new Error("Packed forecast requires an explicit model name");
      const label = row.m;
      if (!models.includes(label)) models.push(label);
      return [models.indexOf(label), PACKED_PHASES.map(phase => {
        const values = row[phase] as Record<string, number>;
        return fields.map(([name]) => {
          const number = values?.[name];
          if (number === undefined || number === null) return null;
          if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`Invalid packed forecast value: ${label}/${phase}/${name}`);
          return number;
        });
      })];
    });
  };
  const services = items.map(({ serviceId, input }) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { serviceId, input };
    const source = input as Record<string, unknown>;
    const s = source.s && typeof source.s === "object" ? { ...source.s as Record<string, unknown> } : source.s;
    const t = source.t && typeof source.t === "object" ? { ...source.t as Record<string, unknown> } : source.t;
    if (s && typeof s === "object" && !Array.isArray(s)) {
      const service = s as Record<string, unknown>;
      if (service.serviceId === serviceId) delete service.serviceId;
      if (t && typeof t === "object" && !Array.isArray(t)) {
        const timing = t as Record<string, unknown>;
        if (timing.departure === service.scheduledDepartureJst && timing.departure !== undefined) delete timing.departure;
        if (timing.arrival === service.scheduledArrivalJst && timing.arrival !== undefined) delete timing.arrival;
      }
    }
    return { serviceId, input: { ...source, s, t, w: packRows(source.w, WEATHER_FIELDS), sea: packRows(source.sea, MARINE_FIELDS) } };
  });
  return { definitions: { phases: PACKED_PHASES, weather: WEATHER_FIELDS, marine: MARINE_FIELDS, models }, services };
}
