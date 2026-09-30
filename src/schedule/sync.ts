import type { ScheduleProvider, ScheduleService } from "./types.js";

function durationMinutes(service: ScheduleService): number {
  return Math.round((Date.parse(service.scheduledArrivalJst) - Date.parse(service.scheduledDepartureJst)) / 60_000);
}

export async function syncSchedule(db: D1Database, provider: ScheduleProvider, fromDate: string, toDate: string, now = new Date()): Promise<{ count: number; syncId: string }> {
  const services = await provider.load(fromDate, toDate);
  if (fromDate > toDate || !services.length) throw new Error("Official timetable returned no services or invalid range");
  const dates = new Set(services.map((row) => row.serviceDate));
  for (let date = fromDate; date <= toDate; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    if (!dates.has(date)) throw new Error(`Official timetable has no services for ${date}`);
  }
  const syncId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const statements = [db.prepare(`UPDATE services SET schedule_active=0, round_trip_id=NULL, paired_service_id=NULL
    WHERE service_date BETWEEN ? AND ?`).bind(fromDate, toDate), ...services.map((row) => db.prepare(`INSERT INTO services
    (id, service_date, service_number, ship_type, origin, destination, counterpart_terminal,
      scheduled_departure, scheduled_arrival, scheduled_duration_minutes, source_url, source_version, round_trip_id, paired_service_id, schedule_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET service_date=excluded.service_date, service_number=excluded.service_number,
      ship_type=excluded.ship_type, origin=excluded.origin, destination=excluded.destination,
      counterpart_terminal=excluded.counterpart_terminal, scheduled_departure=excluded.scheduled_departure,
      scheduled_arrival=excluded.scheduled_arrival, scheduled_duration_minutes=excluded.scheduled_duration_minutes,
      source_url=excluded.source_url, source_version=excluded.source_version,
      round_trip_id=NULL, paired_service_id=NULL, schedule_active=1, updated_at=excluded.updated_at`).bind(
        row.id, row.serviceDate, row.serviceNumber, row.shipType, row.origin, row.destination, row.counterpartTerminal,
        row.scheduledDepartureJst, row.scheduledArrivalJst, durationMinutes(row), row.sourceUrl, row.sourceVersion, timestamp, timestamp
      ))];
  statements.push(db.prepare(`INSERT INTO schedule_syncs
    (id, source, source_url, source_version, range_start, range_end, service_count, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(syncId, provider.name, provider.sourceUrl, provider.sourceVersion, fromDate, toDate, services.length, timestamp));
  await db.batch(statements);
  return { count: services.length, syncId };
}
