import test from "node:test";
import assert from "node:assert/strict";
import { parseOfficialStatuses } from "../src/schedule/official-status.js";

const page = `<div class="scheduleIsland__section sp--js--accordion" id="Oshima">
<div class="scheduleTable"><h3 class="title">大島行き</h3><div class="caption">2026年9月29日（火）8:59 現在 運航状況</div><table class="stable">
<tr><th>header</th></tr><tr><td>08:35</td><td>東京発</td><td>ジェット船 1220便</td><td>岡田港</td><td class="status"><i class="icon icon--ok"></i><span>就航</span></td><td>残席わずか</td></tr>
<tr><td>14:00</td><td>東京発</td><td>ジェット船 1230便</td><td>---</td><td class="status"><i class="icon icon--weather"></i><span>天候調査中</span></td><td></td></tr></table></div>
<div class="scheduleTable"><h3 class="title">大島発</h3><div class="caption">2026年9月29日（火）8:59 現在 運航状況</div><table class="stable">
<tr><td>10:15</td><td>東京行</td><td>ジェット船 2210便</td><td>岡田港</td><td class="status"><i class="icon icon--attention"></i></td><td>接岸できない場合があります。</td></tr>
<tr><td>15:15</td><td>東京行</td><td>ジェット船 2220便</td><td>---</td><td class="status"><span>---</span></td><td>【本日は運休日】</td></tr></table></div>
</div><!-- scheduleIsland__section / Oshima -->`;

test("parses official Oshima service statuses without inferring departure", () => {
  const rows = parseOfficialStatuses(page);
  assert.deepEqual(rows.map(({ serviceNumber, direction, status, port }) => ({ serviceNumber, direction, status, port })), [
    { serviceNumber: "1220", direction: "to_oshima", status: "就航", port: "岡田港" },
    { serviceNumber: "1230", direction: "to_oshima", status: "天候調査中", port: null },
    { serviceNumber: "2210", direction: "from_oshima", status: "条件付き就航", port: "岡田港" },
    { serviceNumber: "2220", direction: "from_oshima", status: "運休日", port: null }
  ]);
  assert.equal(rows[0]?.sourceUpdatedAt, "2026-09-29T08:59:00+09:00");
});
