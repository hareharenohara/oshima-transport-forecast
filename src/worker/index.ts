import modelBundleJson from "../../models/cloudflare_portable_model.json" with { type: "json" };
import { ROUTE_POINTS } from "../config/forecast-points.js";
import { fetchForecasts } from "../forecast/open-meteo.js";
import { buildFeatures, validateFeatures } from "../ml/build-features.js";
import { predictRisk, type ModelBundle } from "../ml/inference.js";
import { assessService } from "../pipeline/assessment.js";
import { readDays, readForecastSeries, readHistory, readService } from "../storage/d1.js";
import type { Direction, ServiceInput, ShipType } from "../types.js";
import { runScheduled } from "./scheduled.js";
import { parsePreferences, parseSubscription, removeSubscription, saveSubscription } from "../notifications/push.js";
import { APP_CSS, APP_HTML, APP_JS, FAVICON_SVG, MANIFEST, OFFICIAL_STATUS_CSS, OFFICIAL_STATUS_JS, PHASE4_CSS, PHASE4_FIX_CSS, PHASE4_JS, PHASE6_CSS, PHASE6_JS, PWA_CSS, PWA_JS, PWA_SETTINGS_CSS, PWA_SETTINGS_JS, SERVICE_WORKER, WEATHER_CHARTS_CSS, WEATHER_CHARTS_JS } from "../ui/assets.js";

const MODEL_BUNDLE: ModelBundle = modelBundleJson;
const MAX_BODY_BYTES = 16 * 1024;
const SHIP_TYPES = new Set<ShipType>(["jet", "large"]);
const DIRECTIONS = new Set<Direction>(["from_oshima", "to_oshima"]);
export interface WorkerEnv { DB?: D1Database; GEMINI_API_KEY?: string; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }

class RequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_REQUEST") {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
  });
}

function asset(body: string, contentType: string, cacheControl = "public, max-age=3600"): Response {
  return new Response(body, { headers: {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  } });
}

async function readJsonWithLimit(request: Request): Promise<unknown> {
  if (!request.body) throw new RequestError("Request body is required");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RequestError("Request body is too large", 413, "PAYLOAD_TOO_LARGE");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel("payload too large");
      throw new RequestError("Request body is too large", 413, "PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new RequestError("Request body must be valid JSON"); }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new RequestError(`${key} must be a non-empty string`);
  return value.trim();
}

function parseService(value: unknown): ServiceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("Body must be a JSON object");
  const input = value as Record<string, unknown>;
  const shipType = requiredString(input, "shipType") as ShipType;
  const direction = requiredString(input, "direction") as Direction;
  const counterpartTerminal = requiredString(input, "counterpartTerminal");
  const scheduledDepartureJst = requiredString(input, "scheduledDepartureJst");
  const scheduledArrivalJst = requiredString(input, "scheduledArrivalJst");
  if (!SHIP_TYPES.has(shipType)) throw new RequestError("shipType must be jet or large");
  if (!DIRECTIONS.has(direction)) throw new RequestError("direction must be from_oshima or to_oshima");
  if (!(counterpartTerminal in ROUTE_POINTS)) throw new RequestError("counterpartTerminal is unsupported");
  if (!scheduledDepartureJst.endsWith("+09:00") || !scheduledArrivalJst.endsWith("+09:00")) throw new RequestError("Scheduled timestamps must be ISO 8601 with +09:00");
  const departure = Date.parse(scheduledDepartureJst);
  const arrival = Date.parse(scheduledArrivalJst);
  if (!Number.isFinite(departure) || !Number.isFinite(arrival) || arrival <= departure) throw new RequestError("scheduledArrivalJst must be later than scheduledDepartureJst");
  if (arrival - departure > 12 * 60 * 60 * 1000) throw new RequestError("Scheduled duration exceeds 12 hours");
  return {
    serviceId: requiredString(input, "serviceId"),
    voyageNumber: requiredString(input, "voyageNumber").replace(/\.0$/, ""),
    shipType, direction, counterpartTerminal, scheduledDepartureJst, scheduledArrivalJst
  };
}

export async function handleRequest(request: Request, fetchFn: typeof fetch = fetch, env: WorkerEnv = {}): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return asset(APP_HTML, "text/html; charset=utf-8", "public, max-age=60");
  if (request.method === "GET" && url.pathname === "/app.css") return asset(`${APP_CSS}\n${PHASE4_CSS}\n${PHASE4_FIX_CSS}\n${PWA_CSS}\n${PWA_SETTINGS_CSS}\n${PHASE6_CSS}\n${WEATHER_CHARTS_CSS}\n${OFFICIAL_STATUS_CSS}`, "text/css; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/app.js") return asset(`${APP_JS}\n${PHASE4_JS}`, "text/javascript; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/pwa.js") return asset(PWA_JS, "text/javascript; charset=utf-8", "no-cache");
  if (request.method === "GET" && url.pathname === "/pwa-settings.js") return asset(PWA_SETTINGS_JS, "text/javascript; charset=utf-8", "no-cache");
  if (request.method === "GET" && url.pathname === "/phase6.js") return asset(PHASE6_JS.replace("panel.textContent='就航見込みの前回差は算出できません · 港予測 変更なし'", "panel.textContent=panel.textContent.replace('nullポイント','就航見込みの前回差は算出できません')"), "text/javascript; charset=utf-8", "no-cache");
  if (request.method === "GET" && url.pathname === "/weather-charts.js") return asset(WEATHER_CHARTS_JS, "text/javascript; charset=utf-8", "no-cache");
  if (request.method === "GET" && url.pathname === "/official-status.js") return asset(OFFICIAL_STATUS_JS, "text/javascript; charset=utf-8", "no-cache");
  if (request.method === "GET" && url.pathname === "/sw.js") return asset(SERVICE_WORKER.replace("oshima-route-v1", "oshima-route-v6").replace("'/pwa.js'", "'/pwa.js','/pwa-settings.js','/phase6.js','/weather-charts.js','/official-status.js'"), "text/javascript; charset=utf-8", "no-cache");
  if (request.method === "GET" && url.pathname === "/favicon.svg") return asset(FAVICON_SVG, "image/svg+xml; charset=utf-8", "public, max-age=86400");
  if (request.method === "GET" && url.pathname === "/manifest.webmanifest") return asset(MANIFEST, "application/manifest+json; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok", modelVersion: MODEL_BUNDLE.schema_version, featuresVersion: "v1-127" });
  }
  if (request.method === "GET" && url.pathname === "/api/push/config") return json({ publicKey: env.VAPID_PUBLIC_KEY ?? null });
  if (url.pathname === "/api/push/subscriptions") {
    if (!env.DB) return json({ error: { code: "STORAGE_UNAVAILABLE", message: "Prediction storage is not configured" }, requestId }, 503);
    if (request.method === "POST") {
      try {
        const body = await readJsonWithLimit(request) as Record<string, unknown>;
        const id = await saveSubscription(env.DB, parseSubscription(body.subscription), parsePreferences(body.preferences));
        return json({ subscriptionId: id }, 201);
      } catch (error) { return json({ error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : "Invalid subscription" }, requestId }, 400); }
    }
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: { code: "INVALID_REQUEST", message: "id is required" }, requestId }, 400);
      await removeSubscription(env.DB, id);
      return new Response(null, { status: 204 });
    }
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST or DELETE" }, requestId }, 405);
  }
  if (request.method === "GET" && url.pathname === "/api/days") {
    if (!env.DB) return json({ error: { code: "STORAGE_UNAVAILABLE", message: "Prediction storage is not configured" }, requestId }, 503);
    const from = url.searchParams.get("from") ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json({ error: { code: "INVALID_REQUEST", message: "from must be YYYY-MM-DD" }, requestId }, 400);
    try { return json({ days: await readDays(env.DB, from), requestId }); }
    catch (error) {
      console.error(JSON.stringify({ event: "storage_read_failed", requestId, route: "days", message: error instanceof Error ? error.message : String(error) }));
      return json({ error: { code: "STORAGE_UNAVAILABLE", message: "保存済み予測を取得できません。" }, requestId }, 503);
    }
  }
  const serviceMatch = url.pathname.match(/^\/api\/services\/([^/]+)(\/history|\/series)?$/);
  if (request.method === "GET" && serviceMatch) {
    if (!env.DB) return json({ error: { code: "STORAGE_UNAVAILABLE", message: "Prediction storage is not configured" }, requestId }, 503);
    const serviceId = decodeURIComponent(serviceMatch[1]!);
    try {
      if (serviceMatch[2] === "/history") return json({ serviceId, history: await readHistory(env.DB, serviceId), requestId });
      if (serviceMatch[2] === "/series") {
        const stored = await readForecastSeries(env.DB, serviceId);
        return stored ? json({ serviceId, ...stored, requestId }) : json({ error: { code: "NOT_FOUND", message: "Forecast series not found" }, requestId }, 404);
      }
      const service = await readService(env.DB, serviceId);
      return service ? json({ service, requestId }) : json({ error: { code: "NOT_FOUND", message: "Service not found" }, requestId }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "storage_read_failed", requestId, route: serviceMatch[2]?.slice(1) ?? "service", serviceId, message: error instanceof Error ? error.message : String(error) }));
      return json({ error: { code: "STORAGE_UNAVAILABLE", message: "保存済み予測を取得できません。" }, requestId }, 503);
    }
  }
  if (!["/api/predict", "/api/assess"].includes(url.pathname)) return json({ error: { code: "NOT_FOUND", message: "Not found" }, requestId }, 404);
  if (request.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, requestId }, 405, { Allow: "POST" });
  try {
    const service = parseService(await readJsonWithLimit(request));
    if (url.pathname === "/api/assess") {
      const assessment = await assessService(service, env.GEMINI_API_KEY, fetchFn);
      console.log(JSON.stringify({ event: "assessment_completed", requestId, serviceId: service.serviceId, aiStatus: assessment.aiStatus, modelCount: assessment.ml.predictions.length }));
      return json({ serviceId: service.serviceId, ...assessment, requestId });
    }
    const forecasts = await fetchForecasts(fetchFn);
    const built = buildFeatures(service, forecasts);
    validateFeatures(built.vector);
    const prediction = predictRisk(built.rawRecord, MODEL_BUNDLE);
    console.log(JSON.stringify({ event: "prediction_completed", requestId, serviceId: service.serviceId, locations: 11, featureCount: 127, modelVersion: prediction.modelVersion }));
    return json({
      serviceId: service.serviceId,
      prediction: {
        cancellationProbability: prediction.cancellationProbability,
        operationProbability: prediction.operationProbability,
        highRisk: prediction.cancellationProbability >= prediction.threshold,
        threshold: prediction.threshold,
        modelVersion: prediction.modelVersion,
        featuresVersion: prediction.featuresVersion
      },
      dataQuality: { status: "complete", locationCount: 11, featureCount: 127, fetchedAt: forecasts.fetchedAt },
      requestId
    });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: { code: error.code, message: error.message }, requestId }, error.status);
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(JSON.stringify({ event: "prediction_failed", requestId, message }));
    return json({ error: { code: "PREDICTION_UNAVAILABLE", message: "現在、一部データを取得できないため予測を更新できません。" }, requestId }, 503);
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, fetch, env);
  },
  scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    if (!env.DB) throw new Error("DB binding is required for scheduled runs");
    ctx.waitUntil(runScheduled(env as WorkerEnv & { DB: D1Database }, controller.scheduledTime));
  }
} satisfies ExportedHandler<WorkerEnv>;
