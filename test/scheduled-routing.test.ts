import test from "node:test";
import assert from "node:assert/strict";
import { DAILY_SCHEDULE_CRON, FORECAST_PREPARE_CRON, FORECAST_PUBLICATION_CRON, forecastPublicationTime, runDailyScheduleSync, scheduledJobForCron } from "../src/worker/scheduled.js";

test("daily timetable, advance forecast, and publication use separate cron triggers", () => {
  assert.equal(DAILY_SCHEDULE_CRON, "0 18 * * *");
  assert.equal(scheduledJobForCron(DAILY_SCHEDULE_CRON), "schedule");
  assert.equal(scheduledJobForCron(FORECAST_PREPARE_CRON), "forecast");
  assert.equal(scheduledJobForCron(FORECAST_PUBLICATION_CRON), "publication");
  assert.equal(forecastPublicationTime(Date.parse("2026-09-30T04:50:00Z")).toISOString(), "2026-09-30T05:00:00.000Z");
  assert.throws(() => scheduledJobForCron("0 1 * * *"));
  assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", hourCycle: "h23" })
    .format(new Date("2026-09-30T18:00:00Z")), "03");
});

test("failed daily timetable fetch does not write an invented schedule", async () => {
  let writes = 0;
  const db = { prepare() { writes++; throw new Error("unexpected DB write"); } } as unknown as D1Database;
  const failingFetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  await assert.rejects(() => runDailyScheduleSync({ DB: db }, Date.parse("2026-09-30T18:00:00Z"), failingFetch), /HTTP 503/);
  assert.equal(writes, 0);
});
