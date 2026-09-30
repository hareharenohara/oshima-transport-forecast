import type { ServiceInput } from "../types.js";

export interface PushEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificationPreferences {
  routeGroup: "all" | "tokyo" | "atami" | "other";
  probabilityThreshold: 30 | 50 | null;
  changeThreshold: number | null;
  notifyRiskTransition: boolean;
  notifyPortChange: boolean;
  notifyOfficialUpdate: boolean;
}

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const decode64url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));

export function parseSubscription(value: unknown): PushSubscriptionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Subscription must be an object");
  const input = value as Record<string, unknown>;
  const keys = input.keys as Record<string, unknown> | undefined;
  if (typeof input.endpoint !== "string" || !input.endpoint.startsWith("https://")) throw new Error("Push endpoint must use HTTPS");
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") throw new Error("Push subscription keys are required");
  if (input.endpoint.length > 2048 || keys.p256dh.length > 256 || keys.auth.length > 128) throw new Error("Push subscription is too large");
  return { endpoint: input.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function parsePreferences(value: unknown): NotificationPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const routeGroup = ["all", "tokyo", "atami", "other"].includes(String(input.routeGroup)) ? String(input.routeGroup) as NotificationPreferences["routeGroup"] : "all";
  const probabilityThreshold = input.probabilityThreshold === 30 || input.probabilityThreshold === 50 ? input.probabilityThreshold : null;
  const changeThreshold = Number.isInteger(input.changeThreshold) && Number(input.changeThreshold) >= 1 && Number(input.changeThreshold) <= 100 ? Number(input.changeThreshold) : null;
  return { routeGroup, probabilityThreshold, changeThreshold, notifyRiskTransition: input.notifyRiskTransition !== false, notifyPortChange: input.notifyPortChange !== false, notifyOfficialUpdate: input.notifyOfficialUpdate !== false };
}

export async function saveSubscription(db: D1Database, subscription: PushSubscriptionInput, preferences: NotificationPreferences): Promise<string> {
  const existing = await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").bind(subscription.endpoint).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at`).bind(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, now, now),
    db.prepare(`INSERT INTO user_notification_preferences (subscription_id, route_group, probability_threshold, change_threshold,
      notify_risk_transition, notify_port_change, notify_official_update, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET route_group=excluded.route_group, probability_threshold=excluded.probability_threshold,
      change_threshold=excluded.change_threshold, notify_risk_transition=excluded.notify_risk_transition,
      notify_port_change=excluded.notify_port_change, notify_official_update=excluded.notify_official_update, updated_at=excluded.updated_at`).bind(
        id, preferences.routeGroup, preferences.probabilityThreshold, preferences.changeThreshold,
        Number(preferences.notifyRiskTransition), Number(preferences.notifyPortChange), Number(preferences.notifyOfficialUpdate), now)
  ]);
  return id;
}

export async function removeSubscription(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id).run();
}

function routeMatches(group: string, terminal: string): boolean {
  return group === "all" || (group === "tokyo" && ["東京", "横浜", "久里浜", "館山"].includes(terminal)) || (group === "atami" && ["熱海", "伊東", "稲取"].includes(terminal)) || (group === "other" && !["東京", "横浜", "久里浜", "館山", "熱海", "伊東", "稲取"].includes(terminal));
}

interface PushAssessment { ai: { port_prediction: string | null } | null; ml: { predictions: Array<{ cancellationProbability: number }> } }

function operationProbability(result: PushAssessment): number | null {
  const values = result.ml.predictions.map((row: { cancellationProbability: number }) => (1 - row.cancellationProbability) * 100);
  return values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : null;
}

async function vapidHeaders(endpoint: string, publicKey: string, privateKey: string, subject: string): Promise<HeadersInit> {
  const publicBytes = decode64url(publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) throw new Error("VAPID public key must be an uncompressed P-256 key");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: base64url(publicBytes.slice(1, 33)), y: base64url(publicBytes.slice(33)), d: base64url(decode64url(privateKey)), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const audience = new URL(endpoint).origin;
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64url(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43_200, sub: subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${payload}`)));
  return { TTL: "300", Authorization: `vapid t=${header}.${payload}.${base64url(signature)}, k=${publicKey}` };
}

interface SubscriberRow { id: string; endpoint: string; route_group: string; probability_threshold: number | null; change_threshold: number | null; notify_risk_transition: number; notify_port_change: number }

export function notificationEventKeys(current: number, previous: number | null, currentPort: string | null, previousPort: string | null, preferences: {
  probabilityThreshold: number | null; changeThreshold: number | null; notifyRiskTransition: boolean; notifyPortChange: boolean;
}): string[] {
  const events: string[] = [];
  if (preferences.probabilityThreshold !== null && current < preferences.probabilityThreshold) events.push(`below-${preferences.probabilityThreshold}`);
  if (previous !== null && preferences.changeThreshold !== null && Math.abs(current - previous) >= preferences.changeThreshold) events.push(`change-${preferences.changeThreshold}`);
  if (previous !== null && preferences.notifyRiskTransition && current < 50 && previous >= 50) events.push("risk-transition");
  if (previousPort && currentPort && preferences.notifyPortChange && previousPort !== currentPort) events.push(`port-${currentPort}`);
  return events;
}

export async function notifyPredictionChanges(env: PushEnv, service: ServiceInput, result: PushAssessment, fetchFn: typeof fetch = fetch): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return 0;
  const current = operationProbability(result);
  if (current === null) return 0;
  const previous = await env.DB.prepare(`SELECT
    (SELECT AVG(operation_probability) * 100 FROM ml_predictions m WHERE m.forecast_run_id = a.forecast_run_id AND m.service_id = a.service_id) value,
    port_prediction FROM ai_predictions a JOIN forecast_runs r ON r.id=a.forecast_run_id
    WHERE a.service_id = ? AND r.status IN ('completed','partial')
      AND (r.publish_at IS NULL OR r.publish_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ORDER BY a.created_at DESC LIMIT 1 OFFSET 1`).bind(service.serviceId).first<{ value: number | null; port_prediction: string | null }>();
  const subscribers = await env.DB.prepare(`SELECT s.id, s.endpoint, p.route_group, p.probability_threshold, p.change_threshold,
    p.notify_risk_transition, p.notify_port_change FROM push_subscriptions s JOIN user_notification_preferences p ON p.subscription_id=s.id`).all<SubscriberRow>();
  let sent = 0;
  for (const subscriber of subscribers.results) {
    if (!routeMatches(subscriber.route_group, service.counterpartTerminal)) continue;
    const events = notificationEventKeys(current, previous?.value ?? null, result.ai?.port_prediction ?? null, previous?.port_prediction ?? null, {
      probabilityThreshold: subscriber.probability_threshold, changeThreshold: subscriber.change_threshold,
      notifyRiskTransition: Boolean(subscriber.notify_risk_transition), notifyPortChange: Boolean(subscriber.notify_port_change)
    });
    const active = new Set(events);
    const states = await env.DB.prepare("SELECT event_key FROM notification_states WHERE subscription_id = ? AND service_id = ?").bind(subscriber.id, service.serviceId).all<{ event_key: string }>();
    for (const state of states.results) if (!active.has(state.event_key)) {
      await env.DB.prepare("DELETE FROM notification_states WHERE subscription_id = ? AND service_id = ? AND event_key = ?").bind(subscriber.id, service.serviceId, state.event_key).run();
    }
    for (const eventKey of events) {
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO notification_states (subscription_id, service_id, event_key, last_notified_at) VALUES (?, ?, ?, ?)`)
        .bind(subscriber.id, service.serviceId, eventKey, new Date().toISOString()).run();
      if (inserted.meta.changes !== 1) continue;
      try {
        const response = await fetchFn(subscriber.endpoint, { method: "POST", headers: await vapidHeaders(subscriber.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT) });
        if (response.ok) sent++;
        else if ([404, 410].includes(response.status)) await removeSubscription(env.DB, subscriber.id);
      } catch { /* Push failure must not fail prediction persistence. */ }
    }
  }
  return sent;
}
