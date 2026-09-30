import test from "node:test";
import assert from "node:assert/strict";
import { parseOfficialTimetablePage } from "../src/schedule/official-timetable.js";
import { verifiedJetCalendar } from "../src/schedule/verified-calendar.js";

const fixture = `<div class="timetableMain__dateselect"></div><h2 class="timetableMain__date">10/9～2027/1/31</h2>
<table class="timetableTable table"><tbody>
<tr><th>船種</th><td></td><td>ジェット船</td><td>ジェット船</td><td>大型客船</td></tr>
<tr><th>運航便コード</th><td></td><td>1210</td><td>1220</td><td>3000</td></tr>
<tr><th>運航日</th><td></td><td>A</td><td>B</td><td>毎日</td></tr>
<tr><td>東京</td><td>発</td><td>08:15</td><td>08:15</td><td>22:00</td></tr>
<tr><td>大島</td><td>着</td><td>10:00</td><td>10:00</td><td>翌06:00</td></tr>
</tbody></table>`;

test("verified official calendar covers all 123 days and selects A/B departures", () => {
  const calendar = verifiedJetCalendar();
  assert.equal(calendar.size, 123);
  assert.equal(calendar.get("2026-10-09"), "A");
  assert.equal(calendar.get("2026-10-14"), "B");
  const rows = parseOfficialTimetablePage(fixture, "https://www.tokaikisen.co.jp/boarding/timetable/example/", ["2026-10-09", "2026-10-14"], "2026-10-09", calendar, "test");
  assert.deepEqual(rows.filter((row) => row.serviceDate === "2026-10-09").map((row) => row.serviceNumber), ["1210", "3000"]);
  assert.deepEqual(rows.filter((row) => row.serviceDate === "2026-10-14").map((row) => row.serviceNumber), ["1220", "3000"]);
  assert.equal(rows.find((row) => row.id === "2026-10-09-3000-東京-大島")?.scheduledArrivalJst, "2026-10-10T06:00:00+09:00");
});

test("changed official table structure fails instead of inventing services", () => {
  assert.throws(() => parseOfficialTimetablePage("<p>unavailable</p>", "https://www.tokaikisen.co.jp/", ["2026-10-09"], "2026-10-09", verifiedJetCalendar(), "test"));
});
