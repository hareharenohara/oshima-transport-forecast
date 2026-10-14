import { readDays, readGroupForecasts, readDailyForecasts } from '../storage/d1.js';
import { actionGuidance, type ActionGrade } from '../pipeline/action-guidance.js';
import { removeSubscription, sendPush, type PushEnv, type PushSubscriptionInput } from './push.js';

export interface FlightPreferences {
  serviceIds: string[];
  mode: 'grades' | 'updates';
  grades: ActionGrade[];
  notifyOfficialUpdate: boolean;
  notifyPortChange: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}
export function parseFlightPreferences(value: unknown): FlightPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('便の通知設定が必要です。');
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.serviceIds) || p.serviceIds.length > 50 || p.serviceIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw Error('対象便は50便まで選べます。');
  if (p.mode !== 'grades' && p.mode !== 'updates') throw Error('通知方式を選んでください。');
  if (!Array.isArray(p.grades) || p.grades.some(g => !['A','B','C','D'].includes(String(g)))) throw Error('通知する評価を確認してください。');
  if (p.mode === 'grades' && !p.grades.length) throw Error('通知する評価を１つ以上選んでください。');
  for (const key of ['quietStart','quietEnd']) if (typeof p[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key] as string)) throw Error('通知停止時間を確認してください。');
  if (p.quietEnabled === true && p.quietStart === p.quietEnd) throw Error('通知停止の開始と終了は別の時刻にしてください。');
  return {serviceIds: [...new Set(p.serviceIds as string[])], mode:p.mode, grades:[...new Set(p.grades as ActionGrade[])],
    notifyOfficialUpdate:p.notifyOfficialUpdate === true, notifyPortChange:p.notifyPortChange === true,
    quietEnabled:p.quietEnabled === true, quietStart:p.quietStart as string, quietEnd:p.quietEnd as string};
}
export function isQuietTime(p: FlightPreferences, now: Date): boolean {
  if (!p.quietEnabled) return false;
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const minutes = (s: string) => Number(s.slice(0,2))*60 + Number(s.slice(3));
  const start=minutes(p.quietStart), end=minutes(p.quietEnd);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
export interface FlightSnapshot {
  grade: ActionGrade | null;
  version: string | null;
  scope: string | null;
  port: string | null;
  official: string | null;
}
interface FlightView { id: string; label: string; departure: string; snapshot: FlightSnapshot }
// Resolve through the same published views and horizon rule used by /api/days.
// Failed/stale refreshes do not generate new grade or update events.
export async function flightViews(db: D1Database, now = new Date()): Promise<Map<string, FlightView>> {
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`)+86400_000).toISOString().slice(0,10);
  const [days, groups, daily] = await Promise.all([readDays(db,today,15), readGroupForecasts(db,today,15), readDailyForecasts(db,today,15)]);
  const views = new Map<string, FlightView>();
  for (const day of days) for (const s of day.services) {
    if (Date.parse(s.scheduled_departure) <= now.getTime()) continue;
    const group = day.date > tomorrow ? groups.find(g => g.date===day.date && g.member_ids.includes(s.service_id)) : undefined;
    const dailyForecast = daily.find(row => row.date === day.date);
    const groupedDay = day.date > tomorrow && groups.some(g => g.date===day.date);
    const fresh = group ? !group.stale && group.ai_status==='generated' : !groupedDay && s.ai_status==='generated' && s.latest_ai_status==='generated';
    const grade = fresh ? (group?.action_guidance.grade ?? (!groupedDay ? actionGuidance(s.evaluation_grade,s.prompt_version).grade : null)) : null;
    const officialDate = s.official_source_updated_at && Number.isFinite(Date.parse(s.official_source_updated_at))
      ? new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(s.official_source_updated_at)) : null;
    const official = day.date===today && s.official_status && officialDate === today ? JSON.stringify([s.official_status,s.official_port]) : null;
    views.set(s.service_id, {id:s.service_id,departure:s.scheduled_departure,
      label:`${day.date} ${s.scheduled_departure.slice(11,16)} ${s.origin} → ${s.destination} ${s.service_number}便`,
      snapshot:{grade, version:fresh ? String(group?.published_at ?? s.prediction_published_at) : null,
        scope:group ? `この便を含む集約評価（${group.label}）` : 'この便の個別評価',
        port:dailyForecast && !dailyForecast.stale ? dailyForecast.assessment?.port_prediction ?? null : null, official}});
  }
  return views;
}
export function flightEvents(current: FlightSnapshot, previous: FlightSnapshot, p: FlightPreferences): string[] {
  const events: string[]=[];
  if (current.grade && current.version && current.version !== previous.version &&
      (p.mode==='updates' || (current.grade!==previous.grade && p.grades.includes(current.grade)))) events.push('forecast');
  if (p.notifyPortChange && current.port && previous.port && current.port!==previous.port) events.push('port');
  if (p.notifyOfficialUpdate && current.official && current.official!==previous.official) events.push('official');
  return events;
}
// Keep the last usable grade when a refresh is unavailable, so a recovery to
// the same grade is not mistaken for a grade transition.
export function mergeSnapshot(current: FlightSnapshot, previous: FlightSnapshot): FlightSnapshot {
  return {...current,grade:current.grade ?? previous.grade, version:current.version ?? previous.version,
    port:current.port ?? previous.port, official:current.official ?? previous.official};
}
export async function saveFlightPreferences(db: D1Database, id: string, p: FlightPreferences, views: Map<string,FlightView>): Promise<void> {
  for (const serviceId of p.serviceIds) if (!views.has(serviceId)) throw Error('出発済み、または運航予定にない便が含まれています。');
  const statements = [db.prepare(`INSERT INTO flight_notification_settings(subscription_id,preferences_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(subscription_id) DO UPDATE SET preferences_json=excluded.preferences_json,updated_at=excluded.updated_at`).bind(id,JSON.stringify(p),new Date().toISOString()),
    db.prepare('DELETE FROM watched_services WHERE subscription_id=? AND service_id NOT IN (SELECT value FROM json_each(?))').bind(id,JSON.stringify(p.serviceIds))];
  for (const serviceId of p.serviceIds) statements.push(db.prepare(`INSERT INTO watched_services(subscription_id,service_id,snapshot_json) VALUES(?,?,?)
    ON CONFLICT(subscription_id,service_id) DO NOTHING`).bind(id,serviceId,JSON.stringify(views.get(serviceId)!.snapshot)));
  await db.batch(statements);
}
export async function readFlightPreferences(db:D1Database,id:string) {
  const row=await db.prepare('SELECT preferences_json FROM flight_notification_settings WHERE subscription_id=?').bind(id).first<{preferences_json:string}>();
  if (!row) return null;
  const p=JSON.parse(row.preferences_json) as FlightPreferences;
  const views=await flightViews(db);
  const watched=await db.prepare('SELECT service_id,preferences_json FROM watched_services WHERE subscription_id=?').bind(id).all<{service_id:string;preferences_json:string|null}>();
  p.serviceIds=watched.results.map(w=>w.service_id).filter(serviceId=>views.has(serviceId));
  return {preferences:p,services:watched.results.filter(w=>views.has(w.service_id)).map(w=>({serviceId:w.service_id,label:views.get(w.service_id)!.label,
    preferences:w.preferences_json?JSON.parse(w.preferences_json) as FlightPreferences:{...p,serviceIds:[w.service_id]}}))};
}
export async function saveWatchedService(db:D1Database,id:string,serviceId:string,p:FlightPreferences,views:Map<string,FlightView>):Promise<void> {
  if (p.serviceIds.length!==1 || p.serviceIds[0]!==serviceId || !views.has(serviceId)) throw Error('通知する便を確認してください。');
  const count=await db.prepare('SELECT COUNT(*) n FROM watched_services WHERE subscription_id=? AND service_id<>?').bind(id,serviceId).first<{n:number}>();
  if ((count?.n??0)>=50) throw Error('登録できる便は50便までです。');
  await db.batch([
    db.prepare(`INSERT INTO flight_notification_settings(subscription_id,preferences_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(subscription_id) DO NOTHING`).bind(id,JSON.stringify(p),new Date().toISOString()),
    db.prepare(`INSERT INTO watched_services(subscription_id,service_id,snapshot_json,preferences_json) VALUES(?,?,?,?)
      ON CONFLICT(subscription_id,service_id) DO UPDATE SET preferences_json=excluded.preferences_json`).bind(id,serviceId,JSON.stringify(views.get(serviceId)!.snapshot),JSON.stringify(p))
  ]);
}
export async function removeWatchedService(db:D1Database,id:string,serviceId:string):Promise<void> {
  await db.prepare('DELETE FROM watched_services WHERE subscription_id=? AND service_id=?').bind(id,serviceId).run();
}
export async function notifyWatchedServices(env:PushEnv,fetchFn:typeof fetch=fetch,now=new Date()):Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return 0;
  const rows=await env.DB.prepare(`SELECT s.id,s.endpoint,s.p256dh,s.auth,COALESCE(w.preferences_json,f.preferences_json) AS preferences_json,w.service_id,w.snapshot_json
    FROM flight_notification_settings f JOIN push_subscriptions s ON s.id=f.subscription_id
    JOIN watched_services w ON w.subscription_id=s.id`).all<{id:string;endpoint:string;p256dh:string;auth:string;preferences_json:string;service_id:string;snapshot_json:string}>();
  if (!rows.results.length) return 0;
  const views=await flightViews(env.DB,now);
  let sent=0;
  for (const row of rows.results) {
    const view=views.get(row.service_id);
    if (!view) {await env.DB.prepare('DELETE FROM watched_services WHERE subscription_id=? AND service_id=?').bind(row.id,row.service_id).run();continue;}
    const p=JSON.parse(row.preferences_json) as FlightPreferences;
    const previous=JSON.parse(row.snapshot_json) as FlightSnapshot;
    const events=flightEvents(view.snapshot,previous,p);
    const nextSnapshot=JSON.stringify(mergeSnapshot(view.snapshot,previous));
    if (!events.length || isQuietTime(p,now)) {
      if (nextSnapshot!==row.snapshot_json) await env.DB.prepare(`UPDATE watched_services SET snapshot_json=?
        WHERE subscription_id=? AND service_id=? AND snapshot_json=? AND (claim_until IS NULL OR claim_until<=?)`)
        .bind(nextSnapshot,row.id,row.service_id,row.snapshot_json,now.toISOString()).run();
      continue;
    }
    const token=crypto.randomUUID();
    const claimed=await env.DB.prepare(`UPDATE watched_services SET claim_token=?,claim_until=?
      WHERE subscription_id=? AND service_id=? AND snapshot_json=? AND (claim_until IS NULL OR claim_until<=?)`)
      .bind(token,new Date(now.getTime()+120_000).toISOString(),row.id,row.service_id,row.snapshot_json,now.toISOString()).run();
    if (claimed.meta.changes!==1) continue;
    let advance=true;
    try {
      const labels={A:'良好',B:'見込',C:'注意',D:'困難'};
      const official=view.snapshot.official ? JSON.parse(view.snapshot.official) as [string,string|null] : null;
      const body=[view.label,...(events.includes('forecast')?[`${view.snapshot.scope}：${labels[view.snapshot.grade!]}`]:[]),
        ...(events.includes('port')?[`港予測：${view.snapshot.port}`]:[]),...(events.includes('official')?[`公式運航情報：${official![0]}${official![1] ? `／発着港：${official![1]}` : ''}`]:[])].join('\n');
      try {
        const subscription:PushSubscriptionInput={endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}};
        const response=await sendPush(env,subscription,{title:'大島航路予報',body,tag:`service-${row.service_id}`,url:`/?service=${encodeURIComponent(row.service_id)}`},fetchFn);
        if ([404,410].includes(response.status)) {await removeSubscription(env.DB,row.id);continue;}
        if (!response.ok) {advance=false;continue;} // Preserve the comparison state for the next tick.
        sent++;
      } catch {advance=false;continue;}
    } finally {
      await env.DB.prepare('UPDATE watched_services SET snapshot_json=?,claim_token=NULL,claim_until=NULL WHERE subscription_id=? AND service_id=? AND claim_token=?')
        .bind(advance?nextSnapshot:row.snapshot_json,row.id,row.service_id,token).run();
    }
  }
  return sent;
}
