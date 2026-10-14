import { actionGuidance } from "../pipeline/action-guidance.js";
import type { DailyAssessment } from "../pipeline/daily-assessment.js";
import { hasJudgmentEvidence } from "../pipeline/judgment-policy.js";
import { pacedGroqFetch, type RateClock } from "../groq/rate-limit.js";
import { assessGroqBatch, assessGroqDaily, GROQ_MODELS, GROQ_PROMPT_VERSION } from "../groq/client.js";
import type { FinalAssessment, ForecastSummary } from "../gemini/client.js";

export interface AiCredentials { groqApiKey?: string; geminiApiKey?: string }
export interface AiAttempt { provider: "groq" | "gemini"; model: string; status: number; promptTokens?: number; completionTokens?: number; totalTokens?: number; stage?: string; requestedIds?: string[]; returnedIds?: unknown[]; finishReason?: string; responseShape?: string; error?: string; responseText?:string }
export interface ProviderAssessmentResult<T> {
  dailyDate?: string; daily?: DailyAssessment | null; dailyError?: string;
  ml: T;
  forecastSummary: ForecastSummary | null;
  ai: FinalAssessment | null;
  aiStatus: "generated" | "unavailable";
  error?: string;
  geminiModels: { summary: string; final: string };
  aiProviders: { summary: string; final: string };
  promptVersion: string;
  aiAudit: { attempts: AiAttempt[]; primaryError?: string };
}

// Compact input/output permits five targets per call. Oversized requests still
// split before sending, preserving every ID and the original result order.
const GROQ_BATCH_SIZE = 5;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function trackedFetch(fetchFn: typeof fetch, attempts: AiAttempt[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body));
    const stage = request.model === GROQ_MODELS.summary ? "summary" : "final";
    const prompt = String(request.messages?.[1]?.content);
    const material = prompt.split("判断材料:\n").at(-1)!;
    const requestedIds = (JSON.parse(material) as { services: Array<{ serviceId: string }> }).services.map(item=>item.serviceId);
    let response: Response;
    try { response = await fetchFn(input, init); }
    catch (error) { attempts.push({ provider: "groq", model: request.model, status: 0, stage, requestedIds, error: error instanceof Error ? error.message : String(error) }); throw error; }
    let provider: AiAttempt["provider"] | undefined;
    let model = "unknown";
    if (url.includes("api.groq.com")) {
      provider = "groq";
      try { model = String(JSON.parse(String(init?.body)).model ?? "unknown"); } catch { /* diagnostic only */ }
    } else if (url.includes("generativelanguage.googleapis.com")) {
      provider = "gemini";
      model = url.match(/models\/([^:]+)/)?.[1] ?? "unknown";
    }
    if (provider) {
      const attempt: AiAttempt = { provider, model, status: response.status, stage, requestedIds };
      try {
        const payload = await response.clone().json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
        attempt.promptTokens = payload.usage?.prompt_tokens ?? payload.usageMetadata?.promptTokenCount;
        attempt.completionTokens = payload.usage?.completion_tokens ?? payload.usageMetadata?.candidatesTokenCount;
        attempt.totalTokens = payload.usage?.total_tokens ?? payload.usageMetadata?.totalTokenCount;
        const raw = payload as any;
        attempt.finishReason = raw.choices?.[0]?.finish_reason;
        if (!response.ok) attempt.error = JSON.stringify(raw.error ?? raw).slice(0, 2000);
        const content = raw.choices?.[0]?.message?.content??raw.error?.failed_generation;
        if (content) {
          attempt.responseText=content.slice(0,16000);
          try {
            const parsed = JSON.parse(content);
            attempt.responseShape = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
            if (Array.isArray(parsed?.services)) attempt.returnedIds = parsed.services.map((row: any) => row?.service_id??row?.id);
          } catch { attempt.responseShape = "invalid_json"; }
        }
      } catch { /* an error response may not contain JSON usage */ }
      attempts.push(attempt);
    }
    return response;
  };
}

function attachAudit<T extends object>(results: T[], attempts: AiAttempt[], primaryError?: string): Array<T & { aiAudit: { attempts: AiAttempt[]; primaryError?: string } }> {
  const audit = { attempts, ...(primaryError ? { primaryError } : {}) };
  return results.map((result) => ({ ...result, aiAudit: audit }));
}

export async function assessBatchWithProviderFallback<T>(items: Array<{ serviceId: string; input: unknown; ml: T; dailyDate?: string }>, credentials: AiCredentials, fetchFn: typeof fetch = fetch, clock?: RateClock): Promise<Array<ProviderAssessmentResult<T> & { action_guidance: ReturnType<typeof actionGuidance> }>> {
  const attempts: AiAttempt[] = [];
  const instrumented = pacedGroqFetch(trackedFetch(fetchFn, attempts), clock);
  const results: Array<Omit<ProviderAssessmentResult<T>, "aiAudit">> = [];
  const errors: string[] = [];
  const completedIds:string[]=[];
  const unavailable=items.filter(item=>!hasJudgmentEvidence(item.input));
  for(const item of unavailable){
    completedIds.push(item.serviceId);
    results.push({ml:item.ml,forecastSummary:null,ai:null,aiStatus:"unavailable",error:"予報データを取得できませんでした。前回の予測を保持して次回更新で再試行します。",geminiModels:GROQ_MODELS,aiProviders:{summary:"none",final:"none"},promptVersion:GROQ_PROMPT_VERSION});
  }
  const unavailableIds=new Set(completedIds);
  const days = new Map<string, typeof items>();
  for (const item of items.filter(item=>!unavailableIds.has(item.serviceId))) {
    const key = item.dailyDate ?? "legacy";
    days.set(key, [...(days.get(key) ?? []), item]);
  }
  const dailyResults = new Map<string, { daily: DailyAssessment | null; dailyError?: string }>();
  const pending = [...days.entries()].flatMap(([date, rows]) => (date === "legacy" ? chunks(rows, GROQ_BATCH_SIZE) : [rows]).map(group=>({group,maxCompletionTokens:date === "legacy"?1600:Math.max(1600,group.length*180+600),judgmentRetry:0,dailyDate:date !== "legacy" && !unavailable.some(item=>item.dailyDate===date) ? date : undefined})));
  while (pending.length > 0) {
    const {group,maxCompletionTokens,judgmentRetry,dailyDate} = pending.shift()!;
    let primaryError: string | undefined;
    if (credentials.groqApiKey) {
      try {
        const assessed=await assessGroqBatch(group, credentials.groqApiKey, instrumented,maxCompletionTokens,dailyDate);
        if(dailyDate) dailyResults.set(dailyDate,{daily:assessed[0]?.daily ?? null,dailyError:assessed[0]?.dailyError});
        for(let index=0;index<assessed.length;index++){
          const result=assessed[index]!,item=group[index]!;
          results.push(result);completedIds.push(item.serviceId);
        }
        continue;
      } catch (error) {
        primaryError = error instanceof Error ? error.message : String(error);
        if(judgmentRetry===0&&/phase=(output_validation|service_coverage|json_parse)/.test(primaryError)){
          pending.unshift({group:group.map(item=>({...item,input:{...(item.input as object),responseCorrection:primaryError}})),maxCompletionTokens,judgmentRetry:1,dailyDate});
          continue;
        }
        if ((primaryError.includes("exceeds single-request budget") || primaryError.includes("insufficient completion budget") || primaryError.includes("phase=completion_limit")) && group.length > 1) {
          errors.push(`Daily batch split (${dailyDate??"targets"}): ${primaryError}`);
          const middle = Math.ceil(group.length / 2);
          pending.unshift({group:group.slice(0,middle),maxCompletionTokens:1600,judgmentRetry,dailyDate:undefined},{group:group.slice(middle),maxCompletionTokens:1600,judgmentRetry,dailyDate:undefined});
          continue;
        }
        if(primaryError.includes("phase=completion_limit") && group.length===1 && maxCompletionTokens===1600){
          // One bounded expansion for a single assessment; minute controller
          // caps it to available space. No repeated retry loop or partial JSON.
          pending.unshift({group,maxCompletionTokens:3200,judgmentRetry,dailyDate});
          continue;
        }
        errors.push(primaryError);
      }
    }
    results.push(...group.map((item) => ({
      ml: item.ml, forecastSummary: null, ai: null, aiStatus: "unavailable" as const,
      error: primaryError ?? "No Groq API key is configured", geminiModels: GROQ_MODELS,
      aiProviders: { summary: "none", final: credentials.groqApiKey ? "groq" : "none" }, promptVersion: GROQ_PROMPT_VERSION
    })));
    completedIds.push(...group.map(item=>item.serviceId));
  }
  const byId=new Map(completedIds.map((id,index)=>[id,results[index]!]));
  if(credentials.groqApiKey) for(const [date,rows] of days) {
    if(date==='legacy'||dailyResults.get(date)?.daily||unavailable.some(item=>item.dailyDate===date))continue;
    const allResults=rows.map(item=>byId.get(item.serviceId)!);
    let dailyError:string|undefined;
    for(let retry=0;retry<2;retry++){
      try {const daily=await assessGroqDaily(rows,allResults,date,credentials.groqApiKey,instrumented);dailyResults.set(date,{daily});dailyError=undefined;break;}
      catch(error){dailyError=error instanceof Error?error.message:String(error);}
    }
    if(dailyError)dailyResults.set(date,{daily:null,dailyError});
  }
  return attachAudit(items.map(item=>({...byId.get(item.serviceId)!, action_guidance: actionGuidance(byId.get(item.serviceId)?.ai?.evaluation_grade, byId.get(item.serviceId)?.promptVersion, byId.get(item.serviceId)?.ai?.grade_scale), ...(item.dailyDate ? {dailyDate:item.dailyDate,...(dailyResults.get(item.dailyDate) ?? {daily:null,dailyError:"日全体の評価を取得できませんでした。"})} : {})})), attempts, errors.length ? errors.join(" | ") : undefined);
}

export async function assessSingleWithProviderFallback<T>(input: unknown, ml: T, credentials: AiCredentials, fetchFn: typeof fetch = fetch): Promise<ProviderAssessmentResult<T>> {
  const service=input&&typeof input==="object"?(input as {service?:{serviceId?:unknown}}).service:undefined;
  const serviceId=typeof service?.serviceId==="string"&&service.serviceId?service.serviceId:"single";
  return (await assessBatchWithProviderFallback([{serviceId,input,ml}],credentials,fetchFn))[0]!;
}
