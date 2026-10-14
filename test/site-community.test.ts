import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { contactFormUrl, handleSiteRequest, type SiteEnv } from '../src/worker/site-community.js';
import { ADMIN_COOKIE, createAdminSession, digest, isSiteAdmin } from '../src/worker/site-auth.js';
import { handleRequest } from '../src/worker/index.js';

function database(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0019_site_community.sql','utf8'));
  sqlite.exec(readFileSync('migrations/0020_site_admin_login.sql','utf8'));
  const db = {
    prepare(sql: string) {
      let values: (string|number|null)[] = [];
      const statement = {
        bind(...args: (string|number|null)[]) { values = args; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results:sqlite.prepare(sql).all(...values) }; },
        async run() { return { meta:sqlite.prepare(sql).run(...values) }; }
      };
      return statement;
    },
    async batch(statements: {run():Promise<unknown>}[]) {
      sqlite.exec('BEGIN');
      try { const result = []; for(const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
      catch(e) { sqlite.exec('ROLLBACK'); throw e; }
    }
  };
  return db as unknown as D1Database;
}
const origin = 'https://example.test';
const password = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const base: SiteEnv = { ADMIN_PASSWORD_HASH:await digest(password) };
const fetchMock = (async () => { throw Error('Unexpected fetch'); }) as typeof fetch;
async function token(env: SiteEnv) { return createAdminSession(new Request(origin),env); }
async function admin(path: string, env: SiteEnv, data?: unknown, method = 'POST') {
  return handleSiteRequest(new Request(origin+path,{method:data===undefined?'GET':method,headers:{Cookie:ADMIN_COOKIE+'='+await token(env),Origin:origin,'Content-Type':'application/json','X-Site-Admin':'1'},body:data===undefined?undefined:JSON.stringify(data)}),env,fetchMock);
}
function login(env: SiteEnv, value = password, extra: Record<string,string> = {}) {
  return handleSiteRequest(new Request(origin+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Site-Admin':'1','CF-Connecting-IP':'192.0.2.1',...extra},body:JSON.stringify({password:value})}),env,fetchMock);
}

test('Login issues protected cookies and logout revokes the server session',async()=>{
  const env={...base,DB:database()};
  assert.equal((await login(env,'incorrect'))?.status,401);
  const response=await login(env);
  assert.equal(response?.status,200);
  const cookie=response!.headers.get('Set-Cookie')!;
  assert.match(cookie,/Secure; HttpOnly; SameSite=Strict; Max-Age=28800/);
  const tokenValue=cookie.split(';')[0]!;
  const req=new Request(origin+'/admin',{headers:{Cookie:tokenValue}});
  assert.equal(await isSiteAdmin(req,env),true);
  const row=await env.DB.prepare('SELECT token_hash FROM site_admin_sessions').first<{token_hash:string}>();
  assert.notEqual(row?.token_hash,tokenValue.split('=')[1]);
  const out=await handleSiteRequest(new Request(origin+'/api/admin/logout',{method:'POST',headers:{Cookie:tokenValue,Origin:origin,'X-Site-Admin':'1'}}),env,fetchMock);
  assert.equal(out?.status,200);assert.match(out!.headers.get('Set-Cookie')!,/Max-Age=0/);
  assert.equal(await isSiteAdmin(req,env),false);
});

test('Sessions reject tampering, expiry, another host, duplicate cookies and password rotation',async()=>{
  const env={...base,DB:database()};
  const value=await token(env),cookie=ADMIN_COOKIE+'='+value;
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{Cookie:cookie}}),env),true);
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{Cookie:ADMIN_COOKIE+'='+value.slice(0,-1)+(value.endsWith('a')?'b':'a')}}),env),false);
  assert.equal(await isSiteAdmin(new Request('https://another.test/',{headers:{Cookie:cookie}}),env),false);
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{Cookie:cookie+'; '+cookie}}),env),false);
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{Cookie:cookie}}),{...env,ADMIN_PASSWORD_HASH:await digest('different-password')}),false);
  await env.DB.prepare('UPDATE site_admin_sessions SET expires_at=0').run();
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{Cookie:cookie}}),env),false);
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{'Cf-Access-Authenticated-User-Email':'owner@example.test'}}),env),false);
});

test('A fresh login replaces the old browser session and the password hash is not accepted as a password',async()=>{
  const env={...base,DB:database()};
  const old=await token(env);
  const oldRequest=new Request(origin,{headers:{Cookie:ADMIN_COOKIE+'='+old}});
  const fresh=await createAdminSession(oldRequest,env);
  assert.notEqual(old,fresh);
  assert.equal(await isSiteAdmin(oldRequest,env),false);
  assert.equal(await isSiteAdmin(new Request(origin,{headers:{Cookie:ADMIN_COOKIE+'='+fresh}}),env),true);
  assert.equal((await login(env,env.ADMIN_PASSWORD_HASH))?.status,401);
});

test('Login rate limit, same origin and secure transport are enforced',async()=>{
  const env={...base,DB:database()};
  for(let n=0;n<5;n++)assert.equal((await login(env,'incorrect'))?.status,401);
  assert.equal((await login(env))?.status,429);
  assert.equal((await login(env,password,{Origin:'https://attacker.test'}))?.status,403);
  assert.equal((await login(env,password,{'X-Site-Admin':''}))?.status,403);
  assert.equal((await login(env,password,{'CF-Connecting-IP':''}))?.status,429);
  const insecure=await handleSiteRequest(new Request('http://example.test/api/admin/login',{method:'POST',headers:{Origin:'http://example.test','X-Site-Admin':'1','Content-Type':'application/json'},body:JSON.stringify({password})}),env,fetchMock);
  assert.equal(insecure?.status,403);
  const logout=await handleSiteRequest(new Request(origin+'/api/admin/logout',{method:'POST',headers:{Origin:'https://attacker.test','X-Site-Admin':'1'}}),env,fetchMock);
  assert.equal(logout?.status,403);
});

test('Unconfigured admin fails closed; unauthenticated users see login but cannot use admin API',async()=>{
  for(const path of ['/admin','/api/admin/announcements']) {
    assert.equal((await handleSiteRequest(new Request(origin+path),{},fetchMock))?.status,503);
  }
  assert.equal((await handleSiteRequest(new Request(origin+'/api/admin/announcements'),base,fetchMock))?.status,401);
  const html=await handleSiteRequest(new Request(origin+'/admin'),base,fetchMock);
  assert.equal(html?.status,200);assert.match(await html!.text(),/admin-login-form/);
});

test('Announcement lifecycle preserves drafts privately and supports publish/edit/unpublish',async()=>{
  const env = {...base,DB:database()};
  const created = await admin('/api/admin/announcements',env,{title:'アプデ',body:'<script>alert(1)</script>',pinned:true,published:false});
  assert.equal(created?.status,200);
  const {id} = await created!.json() as {id:string};
  const publicList = () => handleSiteRequest(new Request(origin+'/api/announcements'),env,fetchMock);
  assert.deepEqual(await (await publicList())!.json(),{announcements:[]});
  await admin('/api/admin/announcements',env,{id,title:'公開',body:'変更しました',pinned:true,published:true});
  let data = await (await publicList())!.json() as {announcements:{title:string,published_at:string}[]};
  assert.equal(data.announcements[0]?.title,'公開');
  const publishedAt = data.announcements[0]!.published_at;
  await admin('/api/admin/announcements',env,{id,title:'編集',body:'追記',pinned:false,published:true});
  data = await (await publicList())!.json() as typeof data;
  assert.equal(data.announcements[0]?.published_at,publishedAt);
  await admin('/api/admin/announcements',env,{id,title:'編集',body:'追記',pinned:false,published:false});
  assert.deepEqual(await (await publicList())!.json(),{announcements:[]});
  assert.equal((await admin('/api/admin/announcements',env,{title:' ',body:'本文',pinned:false,published:true}))?.status,400);
});

test('Admin mutations reject other origins and missing CSRF header',async()=>{
  for(const [requestOrigin,header] of [['https://attacker.test','1'],[origin,'']]) {
    const env={...base,DB:database()};
    const response=await handleSiteRequest(new Request(origin+'/api/admin/announcements',{method:'POST',headers:{Cookie:ADMIN_COOKIE+'='+await token(env),Origin:requestOrigin!,'X-Site-Admin':header!,'Content-Type':'application/json'},body:'{}'}),env,fetchMock);
    assert.equal(response?.status,403);
  }
});

test('External contact works without Access or D1 and accepts Google responder links only',async()=>{
  const url='https://docs.google.com/forms/d/e/test-form/viewform?usp=sharing';
  assert.equal(contactFormUrl(url),url);
  assert.equal(contactFormUrl('https://forms.gle/test123'),'https://forms.gle/test123');
  for(const bad of ['javascript:alert(1)','https://attacker.test/forms/d/e/test/viewform','https://docs.google.com/forms/d/test/edit','https://forms.gle@attacker.test/test','https://forms.gle/test/x','http://forms.gle/test']) assert.equal(contactFormUrl(bad),null);
  const page=await handleSiteRequest(new Request(origin+'/contact'),{CONTACT_FORM_URL:url},fetchMock);
  assert.equal(page?.status,200);
  assert.match(await page!.text(),/Googleフォームを開く/);
  for(const path of ['/api/contact','/api/contact/config','/site-contact.js','/api/admin/contacts']) {
    assert.equal((await handleSiteRequest(new Request(origin+path),{},fetchMock))?.status,410);
  }
});

test('Public pages expose no admin data, show footer and load separate scripts with scoped CSP',async()=>{
  const home=await (await handleRequest(new Request(origin+'/'))).text();
  assert.ok(home.indexOf('id="site-news"') < home.indexOf('id="days"'));
  assert.match(home,/個人の趣味/); assert.match(home,/予告なく/); assert.match(home,/\/contact/);
  const contact=await handleSiteRequest(new Request(origin+'/contact'),{},fetchMock);
  assert.doesNotMatch(contact!.headers.get('Content-Security-Policy')!,/challenges.cloudflare.com/);
  const html=await contact!.text();
  assert.match(html,/個別の返信は行っていません/);
  assert.match(html,/受付を準備しています/);
  assert.doesNotMatch(html,/<form/);
  const sw=await (await handleRequest(new Request(origin+'/sw.js'))).text();
  assert.match(sw,/url\.pathname==='\/admin'/);
  assert.match(sw,/url\.pathname\.startsWith\('\/api\/admin\/'\)/);
  assert.match(sw,/url\.pathname==='\/api\/announcements'/);
});
