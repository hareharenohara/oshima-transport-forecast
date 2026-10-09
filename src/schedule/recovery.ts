import { syncSchedule } from "./sync.js";
import type { ScheduleProvider } from "./types.js";

export function scheduleDates(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  for (let date = fromDate; date <= toDate; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) dates.push(date);
  return dates;
}

export interface ScheduleSyncReport {
  count: number;
  syncIds: string[];
  failedDates: string[];
}

// Each successful date commits atomically. Failed dates keep their existing rows.
export async function syncScheduleResilient(db: D1Database, provider: ScheduleProvider, fromDate: string, toDate: string, now = new Date()): Promise<ScheduleSyncReport> {
  try {
    const result = await syncSchedule(db, provider, fromDate, toDate, now);
    return { count: result.count, syncIds: [result.syncId], failedDates: [] };
  } catch (error) {
    console.warn(JSON.stringify({ event: "schedule_range_retry", fromDate, toDate, message: String(error) }));
  }
  const report: ScheduleSyncReport = { count: 0, syncIds: [], failedDates: [] };
  for (const date of scheduleDates(fromDate, toDate)) {
    try {
      const result = await syncSchedule(db, provider, date, date, now);
      report.count += result.count;
      report.syncIds.push(result.syncId);
    } catch (error) {
      report.failedDates.push(date);
      console.error(JSON.stringify({ event: "schedule_date_retained", date, message: String(error) }));
    }
  }
  return report;
}

export function latestDailyScheduleTime(now: Date): string {
  const cutoff = new Date(now);
  cutoff.setUTCHours(18, 0, 0, 0); // 03:00 JST
  if (cutoff > now) cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  return cutoff.toISOString();
}

// A cached date still needs retrying when today's official refresh did not succeed.
export async function ensureForecastSchedule(db: D1Database, provider: ScheduleProvider, now: Date, targetTime = now): Promise<ScheduleSyncReport> {
  const jstDate = (date: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(date);
  const dates = scheduleDates(jstDate(targetTime), jstDate(new Date(targetTime.getTime() + 4 * 86_400_000)));
  const fresh = await db.prepare(`SELECT DISTINCT s.service_date FROM services s
    WHERE s.schedule_active=1 AND s.service_date BETWEEN ? AND ?
      AND EXISTS (SELECT 1 FROM schedule_syncs ss WHERE ss.range_start <= s.service_date
        AND ss.range_end >= s.service_date AND ss.synced_at >= ? AND ss.source LIKE 'tokai-kisen-official-html%')`)
    .bind(dates[0], dates.at(-1), latestDailyScheduleTime(now)).all<{ service_date: string }>();
  const available = new Set(fresh.results.map(row => row.service_date));
  const report: ScheduleSyncReport = { count: 0, syncIds: [], failedDates: [] };
  for (const date of dates.filter(date => !available.has(date))) {
    const result = await syncScheduleResilient(db, provider, date, date, now);
    report.count += result.count;
    report.syncIds.push(...result.syncIds);
    report.failedDates.push(...result.failedDates);
  }
  return report;
}
