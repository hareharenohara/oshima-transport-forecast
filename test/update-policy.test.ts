import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { nextForecastUpdate, dueForecastHorizons, selectDueForecastServices, type OfficialPredictionStatus } from "../src/worker/update-policy.js";
import { acquireRun, upcomingServices, readLatestPublishedRunSlot } from "../src/storage/d1.js";
import { runScheduled, forecastPublicationTime, FORECAST_PREPARE_CRON, FORECAST_PUBLICATION_CRON, DAILY_SCHEDULE_CRON } from "../src/worker/scheduled.js";
import type { ServiceInput } from "../src/types.js";
const at = (time: string) => new Date(`2026-10-07T${time}:00+09:00`);
const service = (id: string, departure: string): ServiceInput => ({ serviceId: id, voyageNumber: id, shipType: "jet", direction: "to_oshima", counterpartTerminal: "東京", scheduledDepartureJst: departure, scheduledArrivalJst: "2026-10-07T16:00:00+09:00" });
const status = (value: string, time = "06:00"): OfficialPredictionStatus => ({ status: value, sourceUpdatedAt: at(time).toISOString() });

test("dispatches all agreed JST clocks across midnight, with no horizon collisions", () => {
  const expected: string[][] = [
    ["00:00","03:00","06:10","08:10","10:10","12:10","14:10","16:10","18:10","20:10","22:10"],
    ["00:30","03:30","06:30","09:30","12:30","15:30","18:30","21:30"],
    ["01:00","05:00","09:00","13:00","17:00","21:00"],
    ["02:00","08:00","14:00","20:00"], ["04:00","16:00"]
  ];
  for (let minute = 0; minute < 1440; minute++) {
    const time = `${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}`;
    assert.deepEqual(dueForecastHorizons(at(time)), expected.flatMap((times, day) => times.includes(time) ? [day] : []), time);
    const preparedAt = new Date(at(time).getTime() - 5 * 60_000);
    assert.deepEqual(dueForecastHorizons(forecastPublicationTime(preparedAt.getTime())),
      expected.flatMap((times, day) => times.includes(time) ? [day] : []), `prepare ${preparedAt.toISOString()}`);
  }
  const config=JSON.parse(readFileSync("wrangler.jsonc","utf8"));
  assert.deepEqual(config.triggers.crons,[FORECAST_PREPARE_CRON,FORECAST_PUBLICATION_CRON,DAILY_SCHEDULE_CRON]);
});

test("preparation crosses JST midnight but targets publication-day horizons and departure cutoff", () => {
  const publishedAt = forecastPublicationTime(Date.parse("2026-10-06T23:55:00+09:00"));
  assert.equal(publishedAt.toISOString(), at("00:00").toISOString());
  assert.deepEqual(dueForecastHorizons(publishedAt), [0]);
  const services = [service("boundary", "2026-10-07T01:00:00+09:00"),
    service("expired", "2026-10-07T00:59:00+09:00")];
  const statuses = new Map(services.map(s => [s.serviceId, status("条件付き就航", "00:00")]));
  assert.deepEqual(selectDueForecastServices(services, publishedAt, statuses).map(s => s.serviceId), ["boundary"]);
  const morning = forecastPublicationTime(at("06:05").getTime());
  assert.deepEqual(dueForecastHorizons(morning), [0]);
  assert.deepEqual(selectDueForecastServices([service("morning", "2026-10-07T07:09:00+09:00")], morning,
    new Map([["morning", status("天候調査中")]])), []);
});

test("overnight includes conditional only; post-announcement includes weather pending only", () => {
  const services=["conditional","investigation","adjusting","operating","cancelled","unknown"].map(id=>service(id,"2026-10-07T14:00:00+09:00"));
  const statuses=new Map([
    ["conditional",status("条件付き就航","00:00")],["investigation",status("天候調査中","00:00")],
    ["adjusting",status("天候調整中","00:00")],["operating",status("就航","00:00")],["cancelled",status("欠航","00:00")]
  ]);
  assert.deepEqual(selectDueForecastServices(services,at("03:00"),statuses).map(s=>s.serviceId),["conditional","investigation","adjusting"]);
  for(const [id,value] of statuses)statuses.set(id,{...value,sourceUpdatedAt:at("06:00").toISOString()});
  assert.deepEqual(selectDueForecastServices(services,at("06:10"),statuses).map(s=>s.serviceId),["investigation","adjusting"]);
  assert.deepEqual(selectDueForecastServices(services,at("06:00"),statuses),[]);
});

test("weather deadline is inclusive; expired, stale, future and missing statuses are excluded", () => {
  const services=[service("boundary","2026-10-07T07:10:00+09:00"),service("expired","2026-10-07T07:09:00+09:00"),
    service("stale","2026-10-07T14:00:00+09:00"),service("premorning","2026-10-07T14:00:00+09:00"),service("future","2026-10-07T14:00:00+09:00")];
  const statuses=new Map(services.map(s=>[s.serviceId,status("天候調査中")]));
  statuses.set("stale",{status:"天候調査中",sourceUpdatedAt:"2026-10-06T18:00:00+09:00"});
  statuses.set("premorning",status("天候調査中","03:00"));
  statuses.set("future",status("天候調査中","06:30"));
  assert.deepEqual(selectDueForecastServices(services,at("06:10"),statuses).map(s=>s.serviceId),["boundary"]);
});

test("selects calendar horizons, including day-four night and naive JST timestamps", () => {
  const services=[service("today","2026-10-07T23:00:00+09:00"),service("tomorrow","2026-10-08 23:00:00"),
    service("four","2026-10-11T23:59:00+09:00"),service("five","2026-10-12T00:00:00+09:00")];
  assert.deepEqual(selectDueForecastServices(services,at("00:30"),new Map()).map(s=>s.serviceId),["tomorrow"]);
  assert.deepEqual(selectDueForecastServices(services,at("04:00"),new Map()).map(s=>s.serviceId),["four"]);
});

test("unmatched ticks do not access storage or external APIs",async()=>{
  const db={prepare(){throw new Error("unexpected storage");}} as unknown as D1Database;
  const fetchFn=(async()=>{throw new Error("unexpected API");}) as typeof fetch;
  assert.equal((await runScheduled({DB:db},at("06:00").getTime(),fetchFn)).status,"not_due");
});

test("minute run identity admits 00:00 and 00:30, rejects repeated execution, and reads full day-four horizon",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  try{
    for(const name of readdirSync("migrations").filter(n=>n.endsWith(".sql")).sort())sqlite.exec(readFileSync(`migrations/${name}`,"utf8"));
    const db={prepare(sql:string){let values:unknown[]=[];return{
      bind(...args:unknown[]){values=args;return this;},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as []).changes)}};},
      async all(){return{results:sqlite.prepare(sql).all(...values as [])};},
      async first(){return sqlite.prepare(sql).get(...values as [])??null;}
    };}} as unknown as D1Database;
    assert.ok(await acquireRun(db,at("00:00")));
    assert.ok(await acquireRun(db,at("00:30")));
    assert.equal(await acquireRun(db,at("00:30")),null);
    sqlite.exec(`INSERT INTO services(id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at)
      VALUES('four-night','2026-10-11','1','jet','東京','大島','東京','2026-10-11T23:00:00+09:00','2026-10-12T01:00:00+09:00',120,'now','now'),
      ('five','2026-10-12','2','jet','東京','大島','東京','2026-10-12T00:00:00+09:00','2026-10-12T02:00:00+09:00',120,'now','now');`);
    assert.deepEqual((await upcomingServices(db,at("04:00"))).map(s=>s.serviceId),["four-night"]);
    // At 06:10 only today is due. With no eligible service, do not fetch weather
    // or AI and do not advance the last published prediction timestamp.
    let externalCalls=0;
    const offline=(async(input:RequestInfo|URL)=>{
      assert.equal(new URL(String(input)).hostname,"www.tokaikisen.co.jp");
      externalCalls++;
      return new Response("unavailable",{status:503});
    }) as typeof fetch;
    const skipped=await runScheduled({DB:db},at("06:05").getTime(),offline);
    assert.equal(skipped.status,"no_targets");
    assert.equal(skipped.errorCount,0);
    assert.ok(externalCalls>0);
    assert.equal(await readLatestPublishedRunSlot(db),null);
  }finally{sqlite.close();}
});


test("card update plans use each horizon and change cadence at JST midnight", () => {
  const rows = (date: string) => [{ scheduled_departure: `${date}T14:00:00+09:00`, official_status: null, official_source_updated_at: null }];
  for (const [date, time] of [["2026-10-08","09:30"],["2026-10-09","09:00"],["2026-10-10","14:00"],["2026-10-11","16:00"]]) {
    assert.deepEqual(nextForecastUpdate(date!,rows(date!),at("08:30")), {at:at(time!).toISOString(),conditional:false});
  }
  assert.deepEqual(nextForecastUpdate("2026-10-09",rows("2026-10-09"),at("23:00")), {
    at:new Date("2026-10-08T00:30:00+09:00").toISOString(), conditional:false
  });
  assert.deepEqual(nextForecastUpdate("2026-10-08",rows("2026-10-08"),at("23:00")), {
    at:new Date("2026-10-08T00:00:00+09:00").toISOString(), conditional:true
  });
});

test("today's card update plans respect official status, freshness and departure cutoff", () => {
  const row = {scheduled_departure:"2026-10-07T09:10:00+09:00",official_status:"天候調整中",official_source_updated_at:at("06:00").toISOString()};
  assert.deepEqual(nextForecastUpdate("2026-10-07",[row],at("07:00")), {at:at("08:10").toISOString(),conditional:false});
  assert.equal(nextForecastUpdate("2026-10-07",[{...row,scheduled_departure:"2026-10-07T09:09:00+09:00"}],at("07:00")),null);
  for(const official_status of ["条件付き就航","就航","欠航",null]) {
    assert.equal(nextForecastUpdate("2026-10-07",[{...row,official_status}],at("07:00")),null);
  }
  assert.equal(nextForecastUpdate("2026-10-07",[{...row,official_source_updated_at:at("03:00").toISOString()}],at("07:00")),null);
  const overnight={...row,official_status:"条件付き就航",official_source_updated_at:at("00:00").toISOString()};
  assert.deepEqual(nextForecastUpdate("2026-10-07",[overnight],at("01:00")),{at:at("03:00").toISOString(),conditional:false});
  assert.deepEqual(nextForecastUpdate("2026-10-07",[overnight],at("04:00")),{at:at("06:10").toISOString(),conditional:true});
  assert.equal(nextForecastUpdate("2026-10-07",[],at("04:00")),null);
});
