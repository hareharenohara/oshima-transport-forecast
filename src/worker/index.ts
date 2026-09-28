import modelBundleJson from "../../models/cloudflare_portable_model.json" with { type: "json" };
import { ROUTE_POINTS } from "../config/forecast-points.js";
import { fetchForecasts } from "../forecast/open-meteo.js";
import { buildFeatures, validateFeatures } from "../ml/build-features.js";
import { predictRisk, type ModelBundle } from "../ml/inference.js";
import { assessService } from "../pipeline/assessment.js";
import { readDays, readHistory, readService } from "../storage/d1.js";
import type { Direction, ServiceInput, ShipType } from "../types.js";
import { runScheduled } from "./scheduled.js";

const MODEL_BUNDLE: ModelBundle = modelBundleJson;
const MAX_BODY_BYTES = 16 * 1024;
const SHIP_TYPES = new Set<ShipType>(["jet", "large"]);
const DIRECTIONS = new Set<Direction>(["from_oshima", "to_oshima"]);
export interface WorkerEnv { DB?: D1Database; GEMINI_API_KEY?: string }

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
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok", modelVersion: MODEL_BUNDLE.schema_version, featuresVersion: "v1-127" });
  }
  if (request.method === "GET" && url.pathname === "/api/days") {
    if (!env.DB) return json({ error: { code: "STORAGE_UNAVAILABLE", message: "Prediction storage is not configured" }, requestId }, 503);
    const from = url.searchParams.get("from") ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json({ error: { code: "INVALID_REQUEST", message: "from must be YYYY-MM-DD" }, requestId }, 400);
    return json({ days: await readDays(env.DB, from), requestId });
  }
  const serviceMatch = url.pathname.match(/^\/api\/services\/([^/]+)(\/history)?$/);
  if (request.method === "GET" && serviceMatch) {
    if (!env.DB) return json({ error: { code: "STORAGE_UNAVAILABLE", message: "Prediction storage is not configured" }, requestId }, 503);
    const serviceId = decodeURIComponent(serviceMatch[1]!);
    if (serviceMatch[2]) return json({ serviceId, history: await readHistory(env.DB, serviceId), requestId });
    const service = await readService(env.DB, serviceId);
    return service ? json({ service, requestId }) : json({ error: { code: "NOT_FOUND", message: "Service not found" }, requestId }, 404);
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
    ctx.waitUntil(runScheduled({ DB: env.DB, GEMINI_API_KEY: env.GEMINI_API_KEY }, controller.scheduledTime));
  }
} satisfies ExportedHandler<WorkerEnv>;
