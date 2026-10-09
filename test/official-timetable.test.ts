import test from "node:test";
import assert from "node:assert/strict";
import { parseOfficialTimetablePage, OfficialTimetableProvider } from "../src/schedule/official-timetable.js";
import { verifiedJetCalendar } from "../src/schedule/verified-calendar.js";
import { readFileSync } from "node:fs";

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

test('timetable fetch retains the native fetch receiver contract',async()=>{
 const mock=async function(this:unknown,url:RequestInfo|URL){
  assert.equal(this,undefined);
  return new Response(String(url).endsWith('/boarding/timetable/')?
   '<a href="https://www.tokaikisen.co.jp/boarding/timetable/example/#Timetable">10/9～28</a>':
   fixture.replace('<td>A</td>','<td>毎日</td>').replace('<td>B</td>','<td>毎日</td>'));
 } as typeof fetch;
 assert.equal((await new OfficialTimetableProvider(mock).load('2026-10-09','2026-10-09')).length,3);
});

test("named vessels retain Tokai jet/large services and exclude other operators", () => {
  const html = fixture.replace("<td>ジェット船</td>", "<td>ジェット船<br />セブンアイランド大漁</td>")
    .replace("<td>大型客船</td>", "<td>大型客船<br />さるびあ丸</td>");
  const rows = parseOfficialTimetablePage(html, "https://www.tokaikisen.co.jp/", ["2026-10-09"], "2026-10-09", verifiedJetCalendar(), "test");
  assert.deepEqual(rows.map(row => [row.serviceNumber, row.shipType]), [["1210", "jet"], ["3000", "large"]]);
  for (const label of ["大型客船<br />おがさわら丸", "客船<br />くろしお丸"]) {
    const other = html.replace("大型客船<br />さるびあ丸", label);
    assert.deepEqual(parseOfficialTimetablePage(other, "https://www.tokaikisen.co.jp/", ["2026-10-09"], "2026-10-09", verifiedJetCalendar(), "test").map(row => row.serviceNumber), ["1210"]);
  }
});

test("named large ship supports single weekdays, weekday ranges and lists", () => {
  for (const [rule, expected] of [["金曜", ["2026-10-09"]], ["日～金曜", ["2026-10-09", "2026-10-11", "2026-10-12"]], ["月・木・土曜", ["2026-10-10", "2026-10-12"]]] as const) {
    const html = fixture.replace("<td>毎日</td>", `<td>${rule}</td>`);
    const rows = parseOfficialTimetablePage(html, "https://www.tokaikisen.co.jp/", ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"], "2026-10-09", verifiedJetCalendar(), "test");
    assert.deepEqual(rows.filter(row => row.shipType === "large").map(row => row.serviceDate), expected);
  }
});

test("October 9-28 official HTML parses jet and Friday/Sunday large departures", () => {
  const html = readFileSync("test/fixtures/official-timetable-2026-10-09.html", "utf8");
  const rows = parseOfficialTimetablePage(html, "https://www.tokaikisen.co.jp/boarding/timetable/10-9%ef%bd%9e28/", ["2026-10-09", "2026-10-10", "2026-10-11"], "2026-10-09", verifiedJetCalendar(), "test");
  assert.deepEqual(rows.filter(row => row.serviceDate === "2026-10-09").map(row => row.serviceNumber), ["1420", "1420", "1110", "2450", "2500", "3500"]);
  assert.deepEqual(rows.filter(row => row.serviceDate === "2026-10-10").map(row => row.serviceNumber), ["1420", "1420", "1110", "2450"]);
  assert.deepEqual(rows.filter(row => row.serviceDate === "2026-10-11").map(row => row.serviceNumber), ["1420", "1420", "1110", "2450", "2500"]);
  assert.ok(rows.every(row => !["3200", "2200", "8100", "9100"].includes(row.serviceNumber)));
});
