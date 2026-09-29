export const OFFICIAL_STATUS_URL = "https://www.tokaikisen.co.jp/schedule/";

export interface OfficialServiceStatus {
  serviceDate: string;
  serviceNumber: string;
  direction: "to_oshima" | "from_oshima";
  status: string;
  port: string | null;
  note: string | null;
  sourceUpdatedAt: string;
}

const text = (html: string) => html
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10)))
  .replace(/\s+/g, " ")
  .trim();

function sourceTimestamp(caption: string): { date: string; iso: string } | null {
  const match = caption.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[^\d]*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  return { date, iso: `${date}T${hour!.padStart(2, "0")}:${minute}:00+09:00` };
}

function normalizeStatus(raw: string, rowHtml: string, note: string): string | null {
  if (raw && raw !== "---") return raw;
  if (/icon--attention/.test(rowHtml)) return "条件付き就航";
  if (/運休日/.test(note)) return "運休日";
  return null;
}

export function parseOfficialStatuses(html: string): OfficialServiceStatus[] {
  const oshima = html.match(/<div class="scheduleIsland__section[^>]*id="Oshima"[\s\S]*?<\/div><!-- scheduleIsland__section \/ Oshima -->/)?.[0];
  if (!oshima) throw new Error("Official status page: Oshima section missing");
  const results: OfficialServiceStatus[] = [];
  for (const table of oshima.matchAll(/<div class="scheduleTable">[\s\S]*?<table class="stable">([\s\S]*?)<\/table>/g)) {
    const block = table[0];
    const title = text(block.match(/<h3 class="title">([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const direction = title === "大島行き" ? "to_oshima" : title === "大島発" ? "from_oshima" : null;
    const updated = sourceTimestamp(text(block.match(/<div class="caption">([\s\S]*?)<\/div>/)?.[1] ?? ""));
    if (!direction || !updated) continue;
    for (const row of table[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1]!.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)];
      if (cells.length < 6) continue;
      const serviceNumber = text(cells[2]![1] ?? "").match(/(\d+)便/)?.[1];
      if (!serviceNumber) continue;
      const portText = text(cells[3]![1] ?? "");
      const note = text(cells[5]![1] ?? "");
      const status = normalizeStatus(text(cells[4]![1] ?? ""), cells[4]![0] ?? "", note);
      if (!status) continue;
      results.push({ serviceDate: updated.date, serviceNumber, direction, status,
        port: portText && portText !== "---" ? portText : null, note: note || null, sourceUpdatedAt: updated.iso });
    }
  }
  return results;
}

export async function fetchOfficialStatuses(fetchFn: typeof fetch = fetch): Promise<OfficialServiceStatus[]> {
  const response = await fetchFn(OFFICIAL_STATUS_URL, { headers: { "User-Agent": "oshima-route-forecast/1.0" } });
  if (!response.ok) throw new Error(`Official status page HTTP ${response.status}`);
  return parseOfficialStatuses(await response.text());
}
