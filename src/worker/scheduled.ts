import { assessService } from "../pipeline/assessment.js";
import { acquireRun, finishRun, logRun, saveAssessment, upcomingServices } from "../storage/d1.js";

export interface ScheduledEnv { DB: D1Database; GEMINI_API_KEY?: string }

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
    const services = await upcomingServices(env.DB, now);
    targetCount = services.length;
    for (const service of services) {
      try {
        const assessment = await assessService(service, env.GEMINI_API_KEY, fetchFn);
        await saveAssessment(env.DB, run.id, service.serviceId, assessment, new Date().toISOString());
        successCount++;
        if (assessment.aiStatus === "unavailable") await logRun(env.DB, run.id, "warn", "gemini_unavailable", service.serviceId, assessment.error);
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
