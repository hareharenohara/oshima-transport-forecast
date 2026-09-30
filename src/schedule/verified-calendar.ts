/**
 * Transcription of the A/B/C calendar displayed on Tokai Kisen's
 * 10/9/2026-1/31/2027 timetable page. The source PNG is checked by hash at
 * runtime before these labels are used; a changed calendar must be reviewed.
 */
export const JET_CALENDAR_IMAGE = "https://www.tokaikisen.co.jp/wordpress/wp-content/uploads/2026/07/43496a962221f9bca2ab7c575b885f81.png";
export const JET_CALENDAR_SHA256 = "f04cd9606adbf324395c0aac63675e702b3c8cc4cad324e4fe24a4b0b9987ba2";

const MONTHS: Record<string, string> = {
  "2026-10": "AAC CAAAAAC CCABAAC CAAAAAC CAABBBC",
  "2026-11": "CAAAAAC CAAAAAC CAABBAC CCABAAC CA",
  "2026-12": "ABAAC CAABAAC CAABBBC CAAAAAC CAAAA",
  "2027-01": "AC CAABAAC CCAAAAC CAABAAC CAABAAC C"
};

export function verifiedJetCalendar(): Map<string, "A" | "B" | "C"> {
  const result = new Map<string, "A" | "B" | "C">();
  for (const [month, encoded] of Object.entries(MONTHS)) {
    const labels = encoded.replace(/\s/g, "");
    const [year, monthNumber] = month.split("-").map(Number);
    const days = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
    if (labels.length !== days || /[^ABC]/.test(labels)) throw new Error(`Invalid verified jet calendar: ${month}`);
    for (let day = 1; day <= days; day++) result.set(`${month}-${String(day).padStart(2, "0")}`, labels[day - 1] as "A" | "B" | "C");
  }
  return result;
}
