import type { ScheduleProvider, ScheduleService } from "./types.js";
import { JET_CALENDAR_IMAGE, JET_CALENDAR_SHA256, verifiedJetCalendar } from "./verified-calendar.js";

const INDEX_URL = "https://www.tokaikisen.co.jp/boarding/timetable/";
const MAX_HTML_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 300_000;

interface PeriodLink { start: string; end: string; url: string; excluded: string[] }
type CellGrid = string[][];

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function cleanText(html: string): string {
  return html.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex: string | undefined, dec: string | undefined) =>
      String.fromCodePoint(Number.parseInt(hex ?? dec!, hex ? 16 : 10)))
    .replace(/\s+/g, " ").trim();
}

function isoDate(year: number, month: number, day: number): string {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new Error(`Invalid official timetable date: ${year}/${month}/${day}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function listedDates(text: string, firstYear: number, firstMonth: number): string[] {
  let month = firstMonth;
  const dates: string[] = [];
  const terms = text.replace(/[\s　]/g, "").split(/[、・，,]/).filter(Boolean);
  for (const term of terms) {
    const match = term.match(/^(?:(\d{1,2})\/)?(\d{1,2})(?:[～〜-](\d{1,2}))?$/);
    if (!match) throw new Error(`Unsupported official timetable date rule: ${text}`);
    if (match[1]) month = Number(match[1]);
    const first = Number(match[2]);
    const last = match[3] ? Number(match[3]) : first;
    if (last < first || last - first > 31) throw new Error(`Invalid official timetable date range: ${text}`);
    const year = firstYear + (month < firstMonth ? 1 : 0);
    for (let day = first; day <= last; day++) dates.push(isoDate(year, month, day));
  }
  return dates;
}

function periodLinks(html: string, targetDate: string): PeriodLink[] {
  const year = Number(targetDate.slice(0, 4));
  const links: PeriodLink[] = [];
  for (const match of html.matchAll(/<a\s+href="([^"]+\/boarding\/timetable\/[^"#]*\/?)#Timetable"[^>]*>([^<]+)<\/a>/gi)) {
    const label = cleanText(match[2]!);
    const main = label.split("※")[0]!;
    const range = main.match(/^(\d{1,2})\/(\d{1,2})～(?:(\d{4})\/)?(?:(\d{1,2})\/)?(\d{1,2})$/);
    if (!range) continue;
    const startMonth = Number(range[1]);
    const endMonth = Number(range[4] ?? range[1]);
    const endYear = range[3] ? Number(range[3]) : year + (endMonth < startMonth ? 1 : 0);
    const startYear = range[3] ? endYear - (endMonth < startMonth ? 1 : 0) : year;
    const start = isoDate(startYear, startMonth, Number(range[2]));
    const end = isoDate(endYear, endMonth, Number(range[5]));
    const excluded = label.includes("※") ? listedDates(label.split("※")[1]!.replace(/除く$/, ""), startYear, startMonth) : [];
    const url = new URL(match[1]!, INDEX_URL);
    if (url.origin !== "https://www.tokaikisen.co.jp") throw new Error("Unexpected official timetable host");
    links.push({ start, end, url: url.href, excluded });
  }
  if (!links.length) throw new Error("Official timetable period selector is missing");
  return links;
}

function tableGrid(tableHtml: string): CellGrid {
  const grid: CellGrid = [];
  for (const [rowNumber, rowMatch] of [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].entries()) {
    const row = grid[rowNumber] ?? (grid[rowNumber] = []);
    let column = 0;
    for (const cell of rowMatch[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while (row[column] !== undefined) column++;
      const value = cleanText(cell[2]!);
      const colspan = Number(cell[1]!.match(/\bcolspan="(\d+)"/i)?.[1] ?? 1);
      const rowspan = Number(cell[1]!.match(/\browspan="(\d+)"/i)?.[1] ?? 1);
      if (colspan > 12 || rowspan > 20) throw new Error("Unexpected official timetable table span");
      for (let r = rowNumber; r < rowNumber + rowspan; r++) {
        const target = grid[r] ?? (grid[r] = []);
        for (let c = column; c < column + colspan; c++) {
          if (target[c] !== undefined) throw new Error("Overlapping official timetable table cells");
          target[c] = value;
        }
      }
      column += colspan;
    }
  }
  return grid;
}

function ruleMatches(rule: string, date: string, periodStart: string, calendar: Map<string, "A" | "B" | "C">): boolean {
  const compact = rule.replace(/(\d)\s+(?=\d)/g, "$1・").replace(/[\s　]/g, "");
  if (!compact) throw new Error("Official timetable operation day is empty");
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (/^[ABC](?:・[ABC])*$/.test(compact)) {
    const label = calendar.get(date);
    if (!label) throw new Error(`Missing verified A/B/C calendar label for ${date}`);
    return compact.split("・").includes(label);
  }
  const exclusion = compact.split("除く");
  if (exclusion.length === 2) {
    const excluded = listedDates(exclusion[0]!, Number(periodStart.slice(0, 4)), Number(periodStart.slice(5, 7)));
    return !excluded.includes(date) && ruleMatches(exclusion[1]!, date, periodStart, calendar);
  }
  if (compact === "毎日") return true;
  if (compact === "月～金曜" || compact === "平日") return weekday >= 1 && weekday <= 5;
  if (compact === "土・日曜" || compact === "土休日") return weekday === 0 || weekday === 6;
  return listedDates(compact, Number(periodStart.slice(0, 4)), Number(periodStart.slice(5, 7))).includes(date);
}

function timeValue(value: string): { time: string; nextDay: boolean } | null {
  const match = value.match(/^(翌)?(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return null;
  return { time: `${match[2]!.padStart(2, "0")}:${match[3]}`, nextDay: Boolean(match[1]) };
}

function portTime(grid: CellGrid, column: number, port: string, action: "発" | "着"): { time: string; nextDay: boolean } | null {
  const row = grid.find((item) => item[0] === port && item[1] === action);
  return row ? timeValue(row[column] ?? "") : null;
}

export function parseOfficialTimetablePage(html: string, sourceUrl: string, dates: string[], periodStart: string, calendar: Map<string, "A" | "B" | "C">, sourceVersion: string): ScheduleService[] {
  const heading = cleanText(html.match(/<h2 class="timetableMain__date">([\s\S]*?)<\/h2>/)?.[1] ?? "");
  if (!heading || !html.includes("timetableMain__dateselect")) throw new Error("Official timetable page structure changed");
  const result = new Map<string, ScheduleService>();
  const tables = [...html.matchAll(/<table\b[^>]*class="[^"]*\btimetableTable\b[^"]*"[^>]*>[\s\S]*?<\/table>/gi)];
  if (!tables.length) throw new Error("Official timetable tables are missing");
  for (const table of tables) {
    const grid = tableGrid(table[0]);
    const code = grid.find((row) => row[0] === "運航便コード");
    const days = grid.find((row) => row[0] === "運航日");
    const ships = grid.find((row) => row[0] === "船種");
    if (!code || !days || !ships || code.length !== days.length || code.length !== ships.length) continue;
    for (let column = 2; column < code.length; column++) {
      const number = code[column];
      if (!number || !/^\d{4}$/.test(number)) continue;
      const shipType = ships[column] === "ジェット船" ? "jet" : ships[column] === "大型客船" ? "large" : null;
      if (!shipType) continue;
      const legs = [
        { origin: "東京", destination: "大島" },
        { origin: "大島", destination: "東京" },
        { origin: "熱海", destination: "大島" },
        { origin: "大島", destination: "熱海" }
      ];
      for (const leg of legs) {
        const departure = portTime(grid, column, leg.origin, "発");
        const arrival = portTime(grid, column, leg.destination, "着");
        if (!departure || !arrival || departure.nextDay) continue;
        for (const date of dates) {
          if (!ruleMatches(days[column] ?? "", date, periodStart, calendar)) continue;
          const arrivalDate = arrival.nextDay ? addDays(date, 1) : date;
          const departureJst = `${date}T${departure.time}:00+09:00`;
          const arrivalJst = `${arrivalDate}T${arrival.time}:00+09:00`;
          const duration = Date.parse(arrivalJst) - Date.parse(departureJst);
          if (!(duration > 0 && duration <= 24 * 3_600_000)) throw new Error(`Invalid official service duration: ${date} ${number}`);
          const id = `${date}-${number}-${leg.origin}-${leg.destination}`;
          const service: ScheduleService = {
            id, serviceDate: date, serviceNumber: number, shipType,
            origin: leg.origin, destination: leg.destination,
            counterpartTerminal: leg.origin === "大島" ? leg.destination : leg.origin,
            scheduledDepartureJst: departureJst, scheduledArrivalJst: arrivalJst,
            sourceUrl, sourceVersion
          };
          const previous = result.get(id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(service)) throw new Error(`Conflicting official service: ${id}`);
          result.set(id, service);
        }
      }
    }
  }
  if (!result.size) throw new Error(`No Oshima services parsed from official timetable: ${sourceUrl}`);
  return [...result.values()].sort((a, b) => a.scheduledDepartureJst.localeCompare(b.scheduledDepartureJst));
}

async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Official timetable HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > limit) throw new Error("Official timetable response too large");
  if (!response.body) throw new Error("Official timetable response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error("Official timetable response too large"); }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class OfficialTimetableProvider implements ScheduleProvider {
  readonly name = "tokai-kisen-official-html";
  readonly sourceUrl = INDEX_URL;
  readonly sourceVersion = "official-period-html-v1";
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async load(fromDate: string, toDate: string): Promise<ScheduleService[]> {
    const index = new TextDecoder().decode(await boundedResponse(await this.fetchFn(INDEX_URL), MAX_HTML_BYTES));
    const calendar = verifiedJetCalendar();
    const groups = new Map<string, { link: PeriodLink; dates: string[] }>();
    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
      const matches = periodLinks(index, date).filter((link) => link.start <= date && date <= link.end && !link.excluded.includes(date));
      if (matches.length !== 1) throw new Error(`Official timetable period is ambiguous or missing for ${date}`);
      const link = matches[0]!;
      const group = groups.get(link.url) ?? { link, dates: [] };
      group.dates.push(date);
      groups.set(link.url, group);
    }
    const result: ScheduleService[] = [];
    let calendarChecked = false;
    for (const { link, dates } of groups.values()) {
      const bytes = await boundedResponse(await this.fetchFn(link.url), MAX_HTML_BYTES);
      const html = new TextDecoder().decode(bytes);
      if (/[ABC](?:・[ABC])?/.test(html.match(/<table\b[\s\S]*?<\/table>/)?.[0] ?? "") || html.includes("高速ジェット船運航日カレンダー")) {
        if (!html.includes(JET_CALENDAR_IMAGE)) throw new Error("Official A/B/C calendar image changed");
        if (!calendarChecked) {
          const image = await boundedResponse(await this.fetchFn(JET_CALENDAR_IMAGE), MAX_IMAGE_BYTES);
          if (await sha256(image) !== JET_CALENDAR_SHA256) throw new Error("Official A/B/C calendar image contents changed");
          calendarChecked = true;
        }
      }
      const version = `official-html-${(await sha256(bytes)).slice(0, 16)}`;
      result.push(...parseOfficialTimetablePage(html, link.url, dates, link.start, calendar, version));
    }
    if (new Set(result.map((row) => row.id)).size !== result.length) throw new Error("Duplicate official service IDs across periods");
    return result.sort((a, b) => a.scheduledDepartureJst.localeCompare(b.scheduledDepartureJst));
  }
}
