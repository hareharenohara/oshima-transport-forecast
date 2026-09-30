import { assessServicesBatch } from "../pipeline/assessment.js";
import { fetchMultiModelSources } from "../forecast/multi-model.js";
import { buildServiceForecastSeries } from "../forecast/service-series.js";
import { fetchOfficialStatuses, OFFICIAL_STATUS_URL } from "../schedule/official-status.js";
import { OfficialTimetableProvider } from "../schedule/official-timetable.js";
import { syncSchedule } from "../schedule/sync.js";
import { acquireRun, claimDuePushRuns, finishRun, logRun, readPreviousPredictionContexts, readRunPushAssessments, saveAssessment, saveForecastSeries, saveOfficialStatuses, upcomingServices } from "../storage/d1.js";
import { notifyPredictionChanges } from "../notifications/push.js";

export interface ScheduledEnv { DB: D1Database; GROQ_API_KEY?: string; GEMINI_API_KEY?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }

export const DAILY_SCHEDULE_CRON = "0 18 * * *"; // 03:00 JST; forecast cron runs every two hours separately.
export const FORECAST_PREPARE_CRON = "50 0,2,4,6,8,10,12,14,16,18,20,22 * * *";
export const FORECAST_PUBLICATION_CRON = "0 1,3,5,7,9,11,13,15,17,19,21,23 * * *";

export function scheduledJobForCron(cron: string): "schedule" | "forecast" | "publication" {
  if (cron === DAILY_SCHEDULE_CRON) return "schedule";
  if (cron === FORECAST_PREPARE_CRON) return "forecast";
  if (cron === FORECAST_PUBLICATION_CRON) return "publication";
  throw new Error(`Unknown scheduled job: ${cron}`);
}

export function forecastPublicationTime(scheduledTime: number): Date {
  const target = new Date(scheduledTime + 10 * 60_000);
  target.setUTCSeconds(0, 0);
  return target;
}

export async function publishDueForecasts(env: ScheduledEnv, fetchFn: typeof fetch = fetch): Promise<number> {
  const due = await claimDuePushRuns(env.DB, new Date());
  for (const runId of due) {
    try {
      const assessments = await readRunPushAssessments(env.DB, runId);
      for (const { service, result } of assessments) {
        try {
          const sent = await notifyPredictionChanges(env, service, result, fetchFn);
          if (sent > 0) await logRun(env.DB, runId, "info", "push_sent", service.serviceId, `${sent} notifications`);
        } catch (error) {
          await logRun(env.DB, runId, "warn", "push_unavailable", service.serviceId, error instanceof Error ? error.message : String(error));
        }
      }
      console.log(JSON.stringify({ event: "forecast_publication_processed", runId, services: assessments.length }));
    } catch (error) {
      console.error(JSON.stringify({ event: "forecast_publication_failed", runId, message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return due.length;
}

export async function runDailyScheduleSync(env: ScheduledEnv, scheduledTime: number, fetchFn: typeof fetch = fetch): Promise<{ count: number; syncId: string }> {
  const now = new Date(scheduledTime);
  const fromDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(now.getTime() - 86_400_000));
  const toDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(now.getTime() + 5 * 86_400_000));
  try {
    const result = await syncSchedule(env.DB, new OfficialTimetableProvider(fetchFn), fromDate, toDate, now);
    console.log(JSON.stringify({ event: "daily_schedule_synced", count: result.count, syncId: result.syncId, fromDate, toDate }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_schedule_sync_failed", fromDate, toDate, message: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}

export async function runScheduled(env: ScheduledEnv, scheduledTime: number, fetchFn: typeof fetch = fetch): Promise<{ status: string; runId?: string; targetCount?: number; successCount?: number; errorCount?: number }> {
  const startedAt = Date.now();
  const now = new Date(scheduledTime);
  const publishAt = forecastPublicationTime(scheduledTime);
  const run = await acquireRun(env.DB, now, publishAt);
  if (!run) {
    console.log(JSON.stringify({ event: "cron_duplicate_skipped", runSlot: now.toISOString() }));
    return { status: "duplicate_skipped" };
  }

  await logRun(env.DB, run.id, "info", "cron_started");
  let successCount = 0;
  let errorCount = 0;
  let targetCount = 0;
  try {
    try {
      const official = await fetchOfficialStatuses(fetchFn);
      const saved = await saveOfficialStatuses(env.DB, official, new Date().toISOString(), OFFICIAL_STATUS_URL);
      await logRun(env.DB, run.id, "info", "official_status_synced", undefined, `${saved} services`);
    } catch (error) {
      await logRun(env.DB, run.id, "warn", "official_status_unavailable", undefined, error instanceof Error ? error.message : String(error));
    }
    const services = await upcomingServices(env.DB, publishAt);
    targetCount = services.length;
    const sources = services.length > 0 ? await fetchMultiModelSources(fetchFn) : undefined;
    const previous = await readPreviousPredictionContexts(env.DB, services.map((service) => service.serviceId));
    const batch = await assessServicesBatch(services, { groqApiKey: env.GROQ_API_KEY, geminiApiKey: env.GEMINI_API_KEY }, fetchFn, sources, previous);
    const audit = batch.assessed[0]?.result.aiAudit;
    await logRun(env.DB, run.id, "info", "ai_batch", undefined, JSON.stringify({ services: batch.assessed.length, attempts: audit?.attempts ?? [], primaryError: audit?.primaryError }));
    for (const failure of batch.failures) {
      errorCount++;
      await logRun(env.DB, run.id, "error", "service_prediction_failed", failure.service.serviceId, failure.error instanceof Error ? failure.error.message : String(failure.error));
    }
    for (const { service, result: assessment } of batch.assessed) {
      try {
        const createdAt = new Date().toISOString();
        await saveAssessment(env.DB, run.id, service.serviceId, assessment, createdAt);
        if (sources) await saveForecastSeries(env.DB, run.id, service.serviceId, buildServiceForecastSeries(service, sources), createdAt);
        successCount++;
        if ((env.GROQ_API_KEY || env.GEMINI_API_KEY) && assessment.aiStatus === "unavailable") await logRun(env.DB, run.id, "warn", "ai_unavailable", service.serviceId, assessment.error);
      } catch (error) {
        errorCount++;
        await logRun(env.DB, run.id, "error", "service_prediction_failed", service.serviceId, error instanceof Error ? error.message : String(error));
      }
    }
    await finishRun(env.DB, run.id, startedAt, targetCount, successCount, errorCount, { forecasts: errorCount === 0 ? "ok" : "partial" });
    if (Date.now() >= publishAt.getTime()) {
      try { await publishDueForecasts(env, fetchFn); }
      catch (error) { console.error(JSON.stringify({ event: "forecast_push_deferred", runId: run.id, message: error instanceof Error ? error.message : String(error) })); }
    }
    console.log(JSON.stringify({ event: "cron_completed", runId: run.id, targetCount, successCount, errorCount, durationMs: Date.now() - startedAt }));
    return { status: errorCount === 0 ? "completed" : successCount > 0 ? "partial" : "failed", runId: run.id, targetCount, successCount, errorCount };
  } catch (error) {
    errorCount++;
    await logRun(env.DB, run.id, "error", "cron_failed", undefined, error instanceof Error ? error.message : String(error));
    await finishRun(env.DB, run.id, startedAt, targetCount, successCount, errorCount, { forecasts: "failed" });
    throw error;
  }
}
