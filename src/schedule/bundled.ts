import type { ScheduleProvider, ScheduleService } from "./types.js";

const SEPTEMBER_URL = "https://www.tokaikisen.co.jp/boarding/timetable/";
const EARLY_OCTOBER_URL = "https://www.tokaikisen.co.jp/boarding/timetable/9-30%EF%BD%9E10-8/";
const WINTER_URL = "https://www.tokaikisen.co.jp/boarding/timetable/10-1%EF%BD%9E2027-1-31/";
const VERSION = "official-timetable-2026-09-30";
const LARGE_OUTBOUND_EXCLUSIONS = new Set(["2026-10-13", "2026-10-27", "2026-10-28", "2026-10-29", "2026-11-17", "2026-11-18", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-16", "2026-12-17", "2027-01-05", "2027-01-19", "2027-01-26"]);
const LARGE_RETURN_EXCLUSIONS = new Set(["2026-10-14", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-18", "2026-11-19", "2026-11-25", "2026-12-02", "2026-12-09", "2026-12-16", "2026-12-17", "2026-12-18", "2027-01-06", "2027-01-20", "2027-01-27"]);

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function service(date: string, number: string, shipType: "jet" | "large", origin: string, destination: string, departure: string, arrival: string, sourceUrl: string, arrivalNextDay = false): ScheduleService {
  const counterpartTerminal = origin === "大島" ? destination : origin;
  return {
    id: `${date}-${number}-${origin}-${destination}`,
    serviceDate: date,
    serviceNumber: number,
    shipType,
    origin,
    destination,
    counterpartTerminal,
    scheduledDepartureJst: `${date}T${departure}:00+09:00`,
    scheduledArrivalJst: `${arrivalNextDay ? addDays(date, 1) : date}T${arrival}:00+09:00`,
    sourceUrl,
    sourceVersion: VERSION
  };
}

function septemberServices(date: string): ScheduleService[] {
  const rows = [
    service(date, "1220", "jet", "東京", "大島", "08:35", "10:20", SEPTEMBER_URL),
    service(date, "1230", "jet", "東京", "大島", "14:00", "15:45", SEPTEMBER_URL),
    service(date, "2210", "jet", "大島", "東京", "10:15", "12:00", SEPTEMBER_URL),
    service(date, "2220", "jet", "大島", "東京", "15:15", "17:00", SEPTEMBER_URL),
    service(date, "1100", "jet", "熱海", "大島", "09:10", "09:55", SEPTEMBER_URL),
    service(date, "2110", "jet", "大島", "熱海", "16:00", "16:45", SEPTEMBER_URL)
  ];
  if (date === "2026-09-30") rows.push(service(date, "3000", "large", "東京", "大島", "22:00", "06:00", SEPTEMBER_URL, true));
  return rows;
}

function earlyOctoberServices(date: string): ScheduleService[] {
  const rows = [
    service(date, "1220", "jet", "東京", "大島", "08:35", "10:20", EARLY_OCTOBER_URL),
    service(date, "1230", "jet", "東京", "大島", "13:25", "15:10", EARLY_OCTOBER_URL),
    service(date, "2210", "jet", "大島", "東京", "10:40", "12:25", EARLY_OCTOBER_URL),
    service(date, "2220", "jet", "大島", "東京", "14:40", "16:25", EARLY_OCTOBER_URL),
    service(date, "2110", "jet", "大島", "熱海", "15:30", date === "2026-10-03" || date === "2026-10-04" ? "16:35" : "16:15", EARLY_OCTOBER_URL)
  ];
  if (date !== "2026-10-03") rows.push(service(date, "1100", "jet", "熱海", "大島", "09:10", date === "2026-10-04" ? "10:15" : "09:55", EARLY_OCTOBER_URL));
  if (date === "2026-10-03") {
    rows.push(service(date, "1200", "jet", "東京", "大島", "08:00", "09:45", EARLY_OCTOBER_URL));
    rows.push(service(date, "1270", "jet", "東京", "大島", "08:15", "10:00", EARLY_OCTOBER_URL));
    rows.push(service(date, "1110", "jet", "熱海", "大島", "11:00", "12:05", EARLY_OCTOBER_URL));
    rows.push(service(date, "2100", "jet", "大島", "熱海", "10:00", "10:45", EARLY_OCTOBER_URL));
  }
  if (date === "2026-10-03" || date === "2026-10-04") {
    rows.push(service(date, "2270", "jet", "大島", "東京", "15:00", "16:45", EARLY_OCTOBER_URL));
  }
  if (date === "2026-10-04") rows.push(service(date, "2500", "large", "大島", "東京", "16:30", "20:55", EARLY_OCTOBER_URL));
  return rows;
}

function winterServices(date: string): ScheduleService[] {
  const rows = [
    service(date, "1230", "jet", "東京", "大島", "13:25", "15:10", WINTER_URL),
    service(date, "2210", "jet", "大島", "東京", "10:40", "12:25", WINTER_URL)
  ];
  if (!LARGE_OUTBOUND_EXCLUSIONS.has(date)) rows.push(service(date, "3000", "large", "東京", "大島", "22:00", date === "2026-12-31" ? "05:30" : "06:00", WINTER_URL, true));
  if (!LARGE_RETURN_EXCLUSIONS.has(date)) {
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    rows.push(service(date, "2000", "large", "大島", "東京", "14:30", weekend ? "19:45" : "19:00", WINTER_URL));
  }
  return rows;
}

export class BundledOfficialScheduleProvider implements ScheduleProvider {
  readonly name = "tokai-kisen-official-bundled";
  readonly sourceUrl = SEPTEMBER_URL;
  readonly sourceVersion = VERSION;

  async load(fromDate: string, toDate: string): Promise<ScheduleService[]> {
    const rows: ScheduleService[] = [];
    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
      if (date >= "2026-09-28" && date <= "2026-09-30") rows.push(...septemberServices(date));
      else if (date >= "2026-10-01" && date <= "2026-10-08") rows.push(...earlyOctoberServices(date));
      else if (date >= "2026-10-09" && date <= "2027-01-31") rows.push(...winterServices(date));
    }
    return rows;
  }
}
