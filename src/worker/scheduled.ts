import { assessServicesBatch } from "../pipeline/assessment.js";
import { fetchMultiModelSources } from "../forecast/multi-model.js";
import { buildServiceForecastSeries } from "../forecast/service-series.js";
import { fetchOfficialStatuses, OFFICIAL_STATUS_URL } from "../schedule/official-status.js";
import { OfficialTimetableProvider } from "../schedule/official-timetable.js";
import { ensureForecastSchedule, syncScheduleResilient, type ScheduleSyncReport } from "../schedule/recovery.js";
import { acquireRun, claimDuePushRuns, finishRun, logRun, readOfficialPredictionStatuses, readPreviousPredictionContexts, readGroupForecasts, saveDailyAssessment, readRunPushAssessments, saveAssessment, saveGroupAssessment, saveForecastSeries, saveOfficialStatuses, upcomingServices } from "../storage/d1.js";
import { notifyPredictionChanges, notifyOfficialStatusChanges } from "../notifications/push.js";
import { dueForecastHorizons, selectDueForecastServices } from "./update-policy.js";

export interface ScheduledEnv { DB: D1Database; GROQ_API_KEY?: string; GEMINI_API_KEY?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }

export const DAILY_SCHEDULE_CRON = "0 18 * * *"; // 03:00 JST; timetable synchronization only.
// Dispatch only matching JST horizons; unused ticks return without DB/API work.
export const FORECAST_PREPARE_CRON = "5,25,55 * * * *";
export const FORECAST_PUBLICATION_CRON = "0,10,30 * * * *";
export const FORECAST_PREPARE_LEAD_MS = 5 * 60_000;

export function scheduledJobForCron(cron: string): "schedule" | "forecast" | "publication" {
  if (cron === DAILY_SCHEDULE_CRON) return "schedule";
  if (cron === FORECAST_PREPARE_CRON) return "forecast";
  if (cron === FORECAST_PUBLICATION_CRON) return "publication";
  throw new Error(`Unknown scheduled job: ${cron}`);
}

export function forecastPublicationTime(scheduledTime: number): Date {
  const target = new Date(scheduledTime + FORECAST_PREPARE_LEAD_MS);
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

export async function runDailyScheduleSync(env: ScheduledEnv, scheduledTime: number, fetchFn: typeof fetch = fetch): Promise<ScheduleSyncReport> {
  const now = new Date(scheduledTime);
  const fromDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(now.getTime() - 86_400_000));
  const toDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(now.getTime() + 14 * 86_400_000));
  try {
    const result = await syncScheduleResilient(env.DB, new OfficialTimetableProvider(fetchFn), fromDate, toDate, now);
    console.log(JSON.stringify({ event: result.failedDates.length ? "daily_schedule_partial" : "daily_schedule_synced", ...result, fromDate, toDate }));
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
  const horizons = dueForecastHorizons(publishAt);
  if (!horizons.length) return { status: "not_due", targetCount: 0 };
  const run = await acquireRun(env.DB, now, publishAt);
  if (!run) {
    console.log(JSON.stringify({ event: "cron_duplicate_skipped", runSlot: now.toISOString() }));
    return { status: "duplicate_skipped" };
  }

  await logRun(env.DB, run.id, "info", "cron_started");
  let successCount = 0;
  let errorCount = 0;
  let targetCount = 0;
  let scheduleStatus: unknown = { status: "unchecked" };
  try {
    try {
      const report = await ensureForecastSchedule(env.DB, new OfficialTimetableProvider(fetchFn), now, publishAt);
      scheduleStatus = { status: report.failedDates.length ? "cached" : "fresh", ...report };
      await logRun(env.DB, run.id, report.failedDates.length ? "warn" : "info", "forecast_schedule_checked", undefined, JSON.stringify(scheduleStatus));
    } catch (error) {
      scheduleStatus = { status: "cached", error: String(error) };
      await logRun(env.DB, run.id, "warn", "forecast_schedule_retry_failed", undefined, String(error));
    }
    try {
      const official = await fetchOfficialStatuses(fetchFn);
      const saved = await saveOfficialStatuses(env.DB, official, new Date().toISOString(), OFFICIAL_STATUS_URL);
      await logRun(env.DB, run.id, "info", "official_status_synced", undefined, `${saved} services`);
      try{await notifyOfficialStatusChanges(env,fetchFn);}catch(error){await logRun(env.DB,run.id,'warn','official_push_unavailable',undefined,String(error));}
    } catch (error) {
      await logRun(env.DB, run.id, "warn", "official_status_unavailable", undefined, error instanceof Error ? error.message : String(error));
    }
    const candidates = await upcomingServices(env.DB, publishAt);
    if (!candidates.length) throw new Error("No upcoming official services available after schedule recovery; retry on next forecast cron");
    const officialStatuses = await readOfficialPredictionStatuses(env.DB, candidates.map(service => service.serviceId));
    const services = selectDueForecastServices(candidates, publishAt, officialStatuses);
    targetCount = services.length;
    await logRun(env.DB, run.id, "info", "forecast_targets_selected", undefined, JSON.stringify({ horizons, candidates: candidates.length, selected: targetCount }));
    if (!targetCount) {
      await finishRun(env.DB, run.id, startedAt, 0, 0, 0, { schedule: scheduleStatus, forecasts: "not_due" });
      return { status: "no_targets", runId: run.id, targetCount: 0, successCount: 0, errorCount: 0 };
    }
    const sources = services.length > 0 ? await fetchMultiModelSources(fetchFn) : undefined;
    const [previous, publishedGroups] = await Promise.all([
      readPreviousPredictionContexts(env.DB, services.map(service => service.serviceId)),
      readGroupForecasts(env.DB, new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo"}).format(publishAt))
    ]);
    const previousGroups = new Map(publishedGroups.filter(group=>group.assessment&&group.action_guidance.grade).map(group=>[group.group_id, {
      evaluationGrade:group.action_guidance.grade, confidenceLevel:group.assessment!.confidence_level,
      portPrediction:group.assessment!.port_prediction, createdAt:String(group.published_at)
    }]));
    const batch = await assessServicesBatch(services, { groqApiKey: env.GROQ_API_KEY, geminiApiKey: env.GEMINI_API_KEY }, fetchFn, sources, previous, publishAt, undefined, previousGroups);
    const audit = batch.assessed[0]?.result.aiAudit;
    const groupedIds=new Set(batch.grouped.flatMap(row=>row.group.members.map(service=>service.serviceId)));
    const aiResults=[...batch.assessed.filter(row=>!groupedIds.has(row.service.serviceId)),...batch.grouped].map(row=>row.result);
    const aiStatus={targets:aiResults.length,generated:aiResults.filter(result=>result.aiStatus==='generated').length,
      unavailable:aiResults.filter(result=>result.aiStatus!=='generated').length};
    errorCount+=aiStatus.unavailable;
    await logRun(env.DB,run.id,aiStatus.unavailable?'warn':'info','ai_generation_status',undefined,JSON.stringify(aiStatus));
    await logRun(env.DB,run.id,'info','forecast_source_status',undefined,JSON.stringify({weather:sources?.weather.map(row=>row.model.label),marine:sources?.marine.map(row=>row.model.label),failures:sources?.failures,mlFailures:batch.assessed.flatMap(row=>row.result.ml.mlFailures??[])}));
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
        if ((env.GROQ_API_KEY || env.GEMINI_API_KEY) && assessment.aiProviders.final !== "none" && assessment.aiStatus === "unavailable") await logRun(env.DB, run.id, "warn", "ai_unavailable", service.serviceId, assessment.error);
      } catch (error) {
        errorCount++;
        await logRun(env.DB, run.id, "error", "service_prediction_failed", service.serviceId, error instanceof Error ? error.message : String(error));
      }
    }
    for (const { group, result } of batch.grouped) {
      try {
        await saveGroupAssessment(env.DB,run.id,group,result,new Date().toISOString());
        await logRun(env.DB,run.id,result.aiStatus === "generated" ? "info" : "warn","group_assessment_saved",undefined,
          JSON.stringify({ groupId:group.id,members:group.members.length,aiStatus:result.aiStatus,error:result.error }));
      } catch (error) {
        errorCount++;
        await logRun(env.DB,run.id,"error","group_assessment_save_failed",undefined,String(error));
      }
    }
    for (const daily of batch.daily) {
      if(!daily.assessment)errorCount++;
      try {
        await saveDailyAssessment(env.DB,run.id,daily,new Date().toISOString());
        await logRun(env.DB,run.id,daily.assessment ? "info" : "warn","daily_assessment_saved",undefined,JSON.stringify({date:daily.date,status:daily.assessment ? "generated" : "unavailable",error:daily.error}));
      } catch(error) {
        errorCount++;
        await logRun(env.DB,run.id,"error","daily_assessment_save_failed",undefined,String(error));
      }
    }
    await finishRun(env.DB, run.id, startedAt, targetCount, successCount, errorCount, { schedule: scheduleStatus, forecasts: errorCount === 0 ? "ok" : "partial", ai:aiStatus });
    if (Date.now() >= publishAt.getTime()) {
      try { await publishDueForecasts(env, fetchFn); }
      catch (error) { console.error(JSON.stringify({ event: "forecast_push_deferred", runId: run.id, message: error instanceof Error ? error.message : String(error) })); }
    }
    console.log(JSON.stringify({ event: "cron_completed", runId: run.id, targetCount, successCount, errorCount, durationMs: Date.now() - startedAt }));
    return { status: errorCount === 0 ? "completed" : successCount > 0 ? "partial" : "failed", runId: run.id, targetCount, successCount, errorCount };
  } catch (error) {
    errorCount++;
    await logRun(env.DB, run.id, "error", "cron_failed", undefined, error instanceof Error ? error.message : String(error));
    await finishRun(env.DB, run.id, startedAt, targetCount, successCount, errorCount, { schedule: scheduleStatus, forecasts: "failed" });
    throw error;
  }
}
