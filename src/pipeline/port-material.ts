import type { MultiModelSources } from "../forecast/multi-model.js";
import type { ServiceInput, HourlyPoint } from "../types.js";
import { forecastSampleWindow } from "../forecast/sample-window.js";

/** One compact comparison for a date; hourly source data stays outside the prompt. */
export function buildPortMaterial(date: string, services: ServiceInput[], sources: MultiModelSources) {
  const base = Date.parse(`${date}T00:00:00+09:00`);
  const windows = services.map(service => {
    const time = Date.parse(service.direction === "to_oshima" ? service.scheduledArrivalJst : service.scheduledDepartureJst);
    return forecastSampleWindow(time - 3_600_000, time + 3_600_000);
  });
  const round = (value: number) => Math.round(value * 100) / 100;
  const ports = ["oshima_west_motomachi", "oshima_north_okata"];
  const rowsAt = (rows: HourlyPoint[], port: string) => rows.filter(row => row.locationId === port && windows.some(([a,b]) => row.timestampMs >= a && row.timestampMs <= b));
  const peak = (rows: HourlyPoint[], variable: string, direction: string) => {
    const values = rows.filter(row => Number.isFinite(row.values[variable]));
    const row = values.reduce<HourlyPoint | undefined>((best,row) => !best || row.values[variable]! > best.values[variable]! ? row : best, undefined);
    return row ? [round(row.values[variable]!), Math.round((row.timestampMs-base)/60_000), Number.isFinite(row.values[direction]) ? round(row.values[direction]!) : null] : null;
  };
  const missing = (rows: HourlyPoint[], variables: string[]) => windows.some(([a,b]) => {
    for(let time=Math.ceil(a/3_600_000)*3_600_000;time<=b;time+=3_600_000)
      if(!variables.every(variable => rows.some(row => row.timestampMs===time && Number.isFinite(row.values[variable])))) return true;
    return false;
  });
  return {
    // Port index 0=元町, 1=岡田; model order is shared across both ports.
    windows: windows.map(([a,b]) => [Math.round((a-base)/60_000),Math.round((b-base)/60_000)]).filter((row,index,all) => all.findIndex(other => JSON.stringify(other)===JSON.stringify(row))===index),
    models: [...sources.weather,...sources.marine].map(source => source.model.label),
    weather: ports.map(port => sources.weather.map(source => {
      const rows=rowsAt(source.rows,port), rain=rows.map(row => row.values.precipitation).filter((value):value is number => Number.isFinite(value));
      return [peak(rows,"wind_speed_10m","wind_direction_10m"),rain.length ? round(Math.max(...rain)) : null,Number(missing(rows,["wind_speed_10m","wind_direction_10m","precipitation"]))];
    })),
    sea: ports.map(port => sources.marine.map(source => {
      const rows=rowsAt(source.rows,port);
      return [peak(rows,"wave_height","wave_direction"),peak(rows,"swell_wave_height","swell_wave_direction"),Number(missing(rows,["wave_height","wave_direction","swell_wave_height","swell_wave_direction"]))];
    })),
    morningLarge: Number(services.some(service => service.shipType==="large" && service.direction==="to_oshima" && new Date(Date.parse(service.scheduledArrivalJst)+9*3_600_000).getUTCHours()<12))
  };
}

export const PORT_RULES = "港選択は就航基準未満を穏やかの定義に使わず、元町/岡田の条件を対等に比較。経験則は公式基準と別で、当日の適用条件を確認し理由の数で投票しない。朝の大型船は実際に対象がある場合だけ一材料とする。風向だけから波が抑制される等の因果を作らない。拮抗・欠損で特定港に固定せず、選んだ決め手と低い確信度を示す。港別差が弱ければ明記。総評本文とport_prediction/port_reasonsは同じ日共通の選択に一致させる。portMaterialは日一回の要約。港順=元町,岡田。modelsはweatherモデル,seaモデルの順。windowsは大島側運航時刻±1時間の和集合（JST0時からの分）。weather各行=[風ピーク,最大時間降水mm,欠損0/1]、sea各行=[波ピーク,うねりピーク,欠損0/1]。ピーク=[値,分,同時刻の方向度]、風m/s・波m。nullは欠損。ピークは同時とは限らず、全時間帯の値でも港の安全保証でもない。morningLarge=朝の大型船対象あり0/1。";
