import type { ServiceInput } from "../types.js";

const DAY = 86_400_000;
const JST = 9 * 3_600_000;
export const FORECAST_UPDATE_MINUTES: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 180, ...Array.from({ length: 9 }, (_, i) => (6 + i * 2) * 60 + 10)],
  Array.from({ length: 8 }, (_, i) => i * 180 + 30),
  Array.from({ length: 6 }, (_, i) => (1 + i * 4) * 60),
  Array.from({ length: 4 }, (_, i) => (2 + i * 6) * 60),
  [240, 960]
];
export const ALL_FORECAST_UPDATE_MINUTES = [...new Set(FORECAST_UPDATE_MINUTES.flat())].sort((a, b) => a - b);

export interface OfficialPredictionStatus { status: string; sourceUpdatedAt: string }

export function departureTime(service: ServiceInput): number {
  const raw = service.scheduledDepartureJst.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}+09:00`);
}

export function dueForecastHorizons(now: Date): number[] {
  const jst = new Date(now.getTime() + JST);
  const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return FORECAST_UPDATE_MINUTES.flatMap((times, day) => times.includes(minute) ? [day] : []);
}

export function selectDueForecastServices(services: ServiceInput[], now: Date, official: ReadonlyMap<string, OfficialPredictionStatus>): ServiceInput[] {
  const current = now.getTime();
  const currentDay = Math.floor((current + JST) / DAY);
  const due = dueForecastHorizons(now);
  return services.filter(service => {
    const departure = departureTime(service);
    const day = Math.floor((departure + JST) / DAY) - currentDay;
    if (!Number.isFinite(departure) || departure <= current || !due.includes(day)) return false;
    if (day !== 0) return true;
    return eligibleToday(departure, current, official.get(service.serviceId));
  });
}

function eligibleToday(departure: number, current: number, status?: OfficialPredictionStatus): boolean {
  if (departure - current < 3_600_000 || !status) return false;
  const currentDay = Math.floor((current + JST) / DAY);
  const source = Date.parse(status.sourceUpdatedAt);
  if (!Number.isFinite(source) || source > current || Math.floor((source + JST) / DAY) !== currentDay) return false;
  const weatherPending = /天候(?:調査|調整)中/.test(status.status);
  const minute = new Date(current + JST).getUTCHours() * 60 + new Date(current + JST).getUTCMinutes();
  if (minute >= 360) return source >= currentDay * DAY - JST + 6 * 3_600_000 && weatherPending;
  return weatherPending || /条件付(?:き)?|★/.test(status.status);
}

export interface UpdateScheduleService {
  scheduled_departure: string;
  official_status: string | null;
  official_source_updated_at: string | null;
}
export interface NextForecastUpdate { at: string; conditional: boolean }

/** Display only: future morning eligibility depends on the new official announcement. */
export function nextForecastUpdate(date: string, services: UpdateScheduleService[], now: Date): NextForecastUpdate | null {
  if (!services.length) return null;
  const targetDay = Math.floor((Date.parse(`${date}T00:00:00+09:00`) + JST) / DAY);
  const current = now.getTime(), currentDay = Math.floor((current + JST) / DAY);
  for (let day = currentDay; day <= targetDay; day++) {
    const horizon = targetDay - day;
    if (horizon < 0 || horizon > 4) continue;
    for (const minute of (FORECAST_UPDATE_MINUTES[horizon] ?? [])) {
      const candidate = day * DAY - JST + minute * 60_000;
      if (candidate <= current) continue;
      const possible = services.filter(s => {
        const raw = s.scheduled_departure.replace(' ', 'T');
        const departure = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}+09:00`);
        return departure > candidate && (horizon !== 0 || departure - candidate >= 3_600_000);
      });
      if (!possible.length) continue;
      if (horizon !== 0) return { at: new Date(candidate).toISOString(), conditional: false };
      if (day !== currentDay) return { at: new Date(candidate).toISOString(), conditional: true };
      if (possible.some(s => eligibleToday(
        Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(s.scheduled_departure) ? s.scheduled_departure.replace(' ', 'T') : `${s.scheduled_departure.replace(' ', 'T')}+09:00`),
        candidate, s.official_status && s.official_source_updated_at ? { status: s.official_status, sourceUpdatedAt: s.official_source_updated_at } : undefined
      ))) return { at: new Date(candidate).toISOString(), conditional: false };
      // Until 06:00 the morning announcement is not known; do not promise an unconditional update.
      if (minute >= 360 && current < currentDay * DAY - JST + 6 * 3_600_000)
        return { at: new Date(candidate).toISOString(), conditional: true };
    }
  }
  return null;
}
