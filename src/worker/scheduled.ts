import { assessServicesBatch } from "../pipeline/assessment.js";
import { fetchMultiModelSources } from "../forecast/multi-model.js";
import { buildServiceForecastSeries } from "../forecast/service-series.js";
import { fetchOfficialStatuses, OFFICIAL_STATUS_URL } from "../schedule/official-status.js";
import { BundledOfficialScheduleProvider } from "../schedule/bundled.js";
import { syncSchedule } from "../schedule/sync.js";
import { acquireRun, finishRun, logRun, saveAssessment, saveForecastSeries, saveOfficialStatuses, upcomingServices } from "../storage/d1.js";
import { notifyPredictionChanges } from "../notifications/push.js";

export interface ScheduledEnv { DB: D1Database; GEMINI_API_KEY?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }

export async function runScheduled(env: ScheduledEnv, scheduledTime: number, fetchFn: typeof fetch = fetch): Promise<{ status: string; runId?: string; targetCount?: number; successCount?: number; errorCount?: number }> {
  const startedAt = Date.now();
  const now = new Date(scheduledTime);
  const run = await acquireRun(env.DB, now);
  if (!run) {
    console.log(JSON.stringify({ event: "cron_duplicate_skipped", runSlot: now.toISOString() }));
    return { status: "duplicate_skipped" };
  }

  await logRun(env.DB, run.id, "info", "cron_started");
  let successCount = 0;
  let errorCount = 0;
  let targetCount = 0;
  try {
    const fromDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(now);
    const rangeEnd = new Date(now.getTime() + 4 * 86_400_000);
    const toDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(rangeEnd);
    const schedule = await syncSchedule(env.DB, new BundledOfficialScheduleProvider(), fromDate, toDate, now);
    await logRun(env.DB, run.id, "info", "schedule_synced", undefined, `${schedule.count} services`);
    try {
      const official = await fetchOfficialStatuses(fetchFn);
      const saved = await saveOfficialStatuses(env.DB, official, new Date().toISOString(), OFFICIAL_STATUS_URL);
      await logRun(env.DB, run.id, "info", "official_status_synced", undefined, `${saved} services`);
    } catch (error) {
      await logRun(env.DB, run.id, "warn", "official_status_unavailable", undefined, error instanceof Error ? error.message : String(error));
    }
    const services = await upcomingServices(env.DB, now);
    targetCount = services.length;
    const sources = services.length > 0 ? await fetchMultiModelSources(fetchFn) : undefined;
    const batch = await assessServicesBatch(services, env.GEMINI_API_KEY, fetchFn, sources);
    await logRun(env.DB, run.id, "info", "gemini_batch", undefined, `${batch.assessed.length} services, ${env.GEMINI_API_KEY && batch.assessed.length ? "2 calls attempted" : "0 calls"}`);
    for (const failure of batch.failures) {
      errorCount++;
      await logRun(env.DB, run.id, "error", "service_prediction_failed", failure.service.serviceId, failure.error instanceof Error ? failure.error.message : String(failure.error));
    }
    for (const { service, result: assessment } of batch.assessed) {
      try {
        const createdAt = new Date().toISOString();
        await saveAssessment(env.DB, run.id, service.serviceId, assessment, createdAt);
        if (sources) await saveForecastSeries(env.DB, run.id, service.serviceId, buildServiceForecastSeries(service, sources), createdAt);
        const pushCount = await notifyPredictionChanges(env, service, assessment, fetchFn);
        if (pushCount > 0) await logRun(env.DB, run.id, "info", "push_sent", service.serviceId, `${pushCount} notifications`);
        successCount++;
        if (env.GEMINI_API_KEY && assessment.aiStatus === "unavailable") await logRun(env.DB, run.id, "warn", "gemini_unavailable", service.serviceId, assessment.error);
      } catch (error) {
        errorCount++;
        await logRun(env.DB, run.id, "error", "service_prediction_failed", service.serviceId, error instanceof Error ? error.message : String(error));
      }
    }
    await finishRun(env.DB, run.id, startedAt, targetCount, successCount, errorCount, { forecasts: errorCount === 0 ? "ok" : "partial" });
    console.log(JSON.stringify({ event: "cron_completed", runId: run.id, targetCount, successCount, errorCount, durationMs: Date.now() - startedAt }));
    return { status: errorCount === 0 ? "completed" : successCount > 0 ? "partial" : "failed", runId: run.id, targetCount, successCount, errorCount };
  } catch (error) {
    errorCount++;
    await logRun(env.DB, run.id, "error", "cron_failed", undefined, error instanceof Error ? error.message : String(error));
    await finishRun(env.DB, run.id, startedAt, targetCount, successCount, errorCount, { forecasts: "failed" });
    throw error;
  }
}
