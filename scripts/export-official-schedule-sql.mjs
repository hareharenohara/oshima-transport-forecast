import { OfficialTimetableProvider } from "../dist/src/schedule/official-timetable.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [fromDate, toDate] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(toDate ?? "") || fromDate > toDate) {
  throw new Error("Usage: node scripts/export-official-schedule-sql.mjs YYYY-MM-DD YYYY-MM-DD");
}
const rows = await new OfficialTimetableProvider().load(fromDate, toDate);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const byDate = new Map();
for (const row of rows) byDate.set(row.serviceDate, [...(byDate.get(row.serviceDate) ?? []), row]);
const allStatements = [];
for (let date = fromDate; date <= toDate; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
  const daily = byDate.get(date);
  if (!daily?.length) throw new Error(`No official departures for ${date}`);
  const statements = daily.map((row) => {
    const duration = Math.round((Date.parse(row.scheduledArrivalJst) - Date.parse(row.scheduledDepartureJst)) / 60_000);
    return `INSERT INTO services (id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,source_url,source_version,schedule_active,round_trip_id,paired_service_id,created_at,updated_at) VALUES (${[
      row.id,row.serviceDate,row.serviceNumber,row.shipType,row.origin,row.destination,row.counterpartTerminal,
      row.scheduledDepartureJst,row.scheduledArrivalJst,duration,row.sourceUrl,row.sourceVersion,1,null,null,new Date().toISOString(),new Date().toISOString()
    ].map((value) => value === null ? "NULL" : typeof value === "number" ? String(value) : quote(value)).join(",")}) ON CONFLICT(id) DO UPDATE SET service_date=excluded.service_date,service_number=excluded.service_number,ship_type=excluded.ship_type,origin=excluded.origin,destination=excluded.destination,counterpart_terminal=excluded.counterpart_terminal,scheduled_departure=excluded.scheduled_departure,scheduled_arrival=excluded.scheduled_arrival,scheduled_duration_minutes=excluded.scheduled_duration_minutes,source_url=excluded.source_url,source_version=excluded.source_version,schedule_active=1,round_trip_id=NULL,paired_service_id=NULL;`;
  });
  statements.push(`UPDATE services SET schedule_active=0,round_trip_id=NULL,paired_service_id=NULL WHERE service_date=${quote(date)} AND id NOT IN (${daily.map((row) => quote(row.id)).join(",")});`);
  allStatements.push(...statements);
  process.stderr.write(`${date}: ${daily.length} official one-way services\n`);
}
const directory = mkdtempSync(join(tmpdir(), "tokai-official-sql-"));
const path = join(directory, "schedule.sql");
writeFileSync(path, allStatements.join("\n") + "\n", { encoding: "utf8", flag: "wx" });
process.stdout.write(path + "\n");
