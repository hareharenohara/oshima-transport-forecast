import { ADMIN_HTML, ADMIN_LOGIN_HTML, ANNOUNCEMENTS_HTML, externalContactHtml, SITE_ADMIN_JS, SITE_LOGIN_JS, SITE_NEWS_JS, SITE_PUBLIC_JS } from '../ui/site-community.js';
import { allowLogin, authConfigured, createAdminSession, isSiteAdmin, passwordMatches, revokeAdminSession, sessionCookie, type SiteAuthEnv } from './site-auth.js';

export interface SiteEnv extends SiteAuthEnv {
  DB?: D1Database;
  CONTACT_FORM_URL?: string;
}
class SiteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const json = (data: unknown, status = 200, headers: Record<string,string> = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
function asset(body: string, type: string): Response {
  return new Response(body, { headers: {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  }});
}
function adminUnavailable(message: string, status: number): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>管理者ログイン | 大島航路</title><link rel="stylesheet" href="/app.css"></head><body><main class="site-page"><a class="site-back" href="/">← 就航予測へ戻る</a><h1>管理者ログイン</h1><div class="site-card"><p class="site-help">${message}</p><a href="/admin">再確認する</a></div></main></body></html>`;
  const response = asset(html,'text/html; charset=utf-8');
  return new Response(response.body,{status,headers:response.headers});
}
function sameOrigin(request: Request, admin = false): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin || (admin && request.headers.get('X-Site-Admin') !== '1')) {
    throw new SiteError(403, 'この画面から再度操作してください。');
  }
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new SiteError(415, '送信形式が正しくありません。');
  if (Number(request.headers.get('Content-Length')) > 24000) throw new SiteError(413, '送信内容が長すぎます。');
  if (!request.body) throw new SiteError(400, '送信内容がありません。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 24000) { await reader.cancel(); throw new SiteError(413, '送信内容が長すぎます。'); }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new SiteError(400, '送信内容が正しくありません。'); }
}
function text(value: unknown, label: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new SiteError(400, `${label}を${max}文字以内で入力してください。`);
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) throw new SiteError(400, '対象が正しくありません。');
  return value;
}
export function contactFormUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if ((url.hostname === 'forms.gle' && /^\/[\w-]+\/?$/.test(url.pathname)) ||
      (url.hostname === 'docs.google.com' && /^\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?[\w-]+\/viewform\/?$/.test(url.pathname))) return url.href;
  } catch { /* Invalid configuration leaves the link unavailable. */ }
  return null;
}

export async function handleSiteRequest(request: Request, env: SiteEnv, fetchFn: typeof fetch): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  const scripts: Record<string,string> = { '/site-public.js':SITE_PUBLIC_JS,'/site-news.js':SITE_NEWS_JS,'/site-admin.js':SITE_ADMIN_JS,'/site-login.js':SITE_LOGIN_JS };
  if (request.method === 'GET' && Object.hasOwn(scripts,path)) return asset(scripts[path]!, 'text/javascript; charset=utf-8');
  if (request.method === 'GET' && path === '/contact') return asset(externalContactHtml(contactFormUrl(env.CONTACT_FORM_URL)),'text/html; charset=utf-8');
  if (request.method === 'GET' && path === '/announcements') return asset(ANNOUNCEMENTS_HTML,'text/html; charset=utf-8');
  if (path === '/api/contact' || path === '/api/contact/config' || path === '/site-contact.js' || path === '/api/admin/contacts' || path.startsWith('/api/admin/contacts/')) return json({ error: { message: 'お問い合わせは外部フォームで受け付けます。', url: '/contact' } }, 410);
  const admin = path === '/admin' || path.startsWith('/api/admin/');
  if (!admin && !['/api/announcements','/api/contact/config','/api/contact'].includes(path)) return null;
  try {
    if (path === '/api/admin/login' || path === '/api/admin/logout') {
      if (request.method !== 'POST') throw new SiteError(405,'この操作には対応していません。');
      sameOrigin(request,true);
      if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new SiteError(403,'安全な接続からログインしてください。');
      if (!authConfigured(env)) throw new SiteError(503,'管理者ログインの設定を準備しています。');
      if (!env.DB) throw new SiteError(503,'現在、ログインを処理できません。時間をおいて再度お試しください。');
      if (path === '/api/admin/logout') {
        await revokeAdminSession(request,env);
        return json({ loggedOut:true },200,{'Set-Cookie':sessionCookie('',0)});
      }
      const data = await body(request);
      if (typeof data.password !== 'string' || !data.password || data.password.length > 256) throw new SiteError(400,'パスワードを入力してください。');
      if (!await allowLogin(request,env)) throw new SiteError(429,'ログインの試行回数が上限に達しました。15分ほど時間をおいて再度お試しください。');
      if (!await passwordMatches(data.password,env)) throw new SiteError(401,'パスワードが正しくありません。');
      const token = await createAdminSession(request,env);
      return json({ loggedIn:true },200,{'Set-Cookie':sessionCookie(token)});
    }
    if (admin) {
      if (!authConfigured(env)) throw new SiteError(503,'管理者ログインの設定を準備しています。');
      if (!await isSiteAdmin(request,env)) {
        if (path === '/admin' && request.method === 'GET') return asset(ADMIN_LOGIN_HTML,'text/html; charset=utf-8');
        throw new SiteError(401,'管理者としてログインしてください。');
      }
      if (path === '/admin' && request.method === 'GET') return asset(ADMIN_HTML,'text/html; charset=utf-8');
      if (!['GET','HEAD'].includes(request.method)) sameOrigin(request,true);
    }
    if (!env.DB) throw new SiteError(503,'現在、情報を取得できません。時間をおいて再度お試しください。');
    const db = env.DB;
    if (path === '/api/announcements' && request.method === 'GET') {
      const rows = await db.prepare('SELECT id,title,body,pinned,published_at FROM site_announcements WHERE published=1 ORDER BY pinned DESC,published_at DESC,id DESC LIMIT 100').all();
      return json({ announcements:rows.results });
    }
    if (path === '/api/admin/announcements') {
      if (request.method === 'GET') {
        const rows = await db.prepare('SELECT * FROM site_announcements ORDER BY updated_at DESC,id DESC LIMIT 200').all();
        return json({ announcements:rows.results });
      }
      if (request.method === 'POST') {
        const data = await body(request);
        const title = text(data.title,'タイトル',120), message = text(data.body,'本文',5000);
        if (typeof data.published !== 'boolean' || typeof data.pinned !== 'boolean') throw new SiteError(400,'公開設定を確認してください。');
        const now = new Date().toISOString();
        let recordId: string;
        if (data.id !== undefined) {
          recordId = id(data.id);
          const old = await db.prepare('SELECT published_at FROM site_announcements WHERE id=?').bind(recordId).first<{published_at:string|null}>();
          if (!old) throw new SiteError(404,'お知らせが見つかりません。');
          await db.prepare('UPDATE site_announcements SET title=?,body=?,published=?,pinned=?,published_at=?,updated_at=? WHERE id=?').bind(title,message,Number(data.published),Number(data.pinned),data.published?(old.published_at??now):old.published_at,now,recordId).run();
        } else {
          recordId = crypto.randomUUID();
          await db.prepare('INSERT INTO site_announcements(id,title,body,published,pinned,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(recordId,title,message,Number(data.published),Number(data.pinned),data.published?now:null,now,now).run();
        }
        return json({ id:recordId });
      }
    }
    return json({ error:{message:'この操作には対応していません。'} },405);
  } catch (error) {
    if (path === '/admin' && request.method === 'GET' && error instanceof SiteError) return adminUnavailable(error.message,error.status);
    if (error instanceof SiteError) return json({ error:{message:error.message} },error.status);
    // Never log contact content or authentication tokens.
    console.error(JSON.stringify({event:'site_community_failed',path}));
    return json({error:{message:'現在、処理できません。時間をおいて再度お試しください。'}},503);
  }
}
