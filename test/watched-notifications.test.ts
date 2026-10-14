import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { flightEvents, flightViews, isQuietTime, mergeSnapshot, notifyWatchedServices, parseFlightPreferences, saveFlightPreferences, saveWatchedService, removeWatchedService, readFlightPreferences, type FlightSnapshot } from '../src/notifications/watched-services.js';
import { encryptPushPayload, saveSubscription, parsePreferences } from '../src/notifications/push.js';
import { handleRequest } from '../src/worker/index.js';

const preferences=()=>parseFlightPreferences({serviceIds:['member'],mode:'grades',grades:['C','D'],notifyOfficialUpdate:true,notifyPortChange:true,quietEnabled:false,quietStart:'22:00',quietEnd:'07:00'});
const snapshot=(grade:FlightSnapshot['grade'],version='v1'):FlightSnapshot=>({grade,version,scope:'group',port:'岡田',official:null});
function database(){
 const sqlite=new DatabaseSync(':memory:');
 for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async all(){return{results:sqlite.prepare(sql).all(...values as [])};},async first(){return sqlite.prepare(sql).get(...values as [])??null;},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as []).changes)}};}};},async batch(statements:Array<{run():Promise<unknown>}>){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
 const now=new Date();
 const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(now.getTime()+4*86400000));
 for(const id of ['member','other'])sqlite.prepare(`INSERT INTO services(id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at) VALUES(?,?,'1','jet','東京','大島','東京',?,?,120,'old','old')`).run(id,date,`${date}T08:00:00+09:00`,`${date}T10:00:00+09:00`);
 function run(id:string,grade:string,group=true,status='generated'){
  const slot=`2000-01-${String(Number(id)+1).padStart(2,'0')}T00:00:00Z`;
  sqlite.prepare(`INSERT INTO forecast_runs(id,run_slot,run_at,status,created_at,completed_at) VALUES(?, ?,?,'completed',?,?)`).run(id,slot,slot,slot,slot);
  if(group)sqlite.prepare(`INSERT INTO group_forecasts(forecast_run_id,group_id,service_date,horizon_days,label,ship_type,member_ids_json,assessment_json,ai_status,model,prompt_version,created_at) VALUES(?,'g',?,4,'午前・東京航路','jet','["member","other"]',?,?,'model','assessment-abcd',?)`).run(id,date,status==='generated'?JSON.stringify({evaluation_grade:grade,grade_scale:'abcd-v1',port_prediction:'岡田'}):null,status,slot);
  else sqlite.prepare(`INSERT INTO ai_predictions(id,forecast_run_id,service_id,evaluation_rating,ai_status,prompt_version,port_prediction,created_at) VALUES(?,?,'member',?,'generated','assessment-abcd','岡田',?)`).run(`a${id}`,id,grade,slot);
 }
 run('0','B');
 return{sqlite,db,now,date,run};
}
const b64=(v:ArrayBuffer|Uint8Array)=>Buffer.from(v instanceof Uint8Array?v:new Uint8Array(v)).toString('base64url');
async function keys(){
 const receiver=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',signing.privateKey);
 const subscription={endpoint:'https://push.example.test/member',keys:{p256dh:b64(await crypto.subtle.exportKey('raw',receiver.publicKey)),auth:b64(crypto.getRandomValues(new Uint8Array(16)))}};
 return{receiver,subscription,VAPID_PUBLIC_KEY:b64(await crypto.subtle.exportKey('raw',signing.publicKey)),VAPID_PRIVATE_KEY:jwk.d!,VAPID_SUBJECT:'mailto:test@example.test'};
}

test('grade transitions, recovery, all updates and independent official changes',()=>{
 const p=preferences();
 assert.deepEqual(flightEvents(snapshot('C','v2'),snapshot('B'),p),['forecast']);
 assert.deepEqual(flightEvents(snapshot('C','v3'),snapshot('C','v2'),p),[]);
 assert.deepEqual(flightEvents(snapshot('A','v4'),snapshot('C'),p),[]);
 assert.deepEqual(flightEvents(snapshot(null,'v5'),snapshot('C'),p),[]);
 const recovered=mergeSnapshot({...snapshot(null),version:null,port:null},snapshot('C'));
 assert.deepEqual(flightEvents(snapshot('C','v6'),recovered,p),[]);
 assert.deepEqual(flightEvents(snapshot('C','v3'),snapshot('C','v2'),{...p,mode:'updates'}),['forecast']);
 assert.deepEqual(flightEvents({...snapshot(null),official:'["欠航","岡田"]'},snapshot('B'),p),['official']);
 assert.throws(()=>parseFlightPreferences({...p,grades:[]}),/１つ以上/);
 assert.throws(()=>parseFlightPreferences({...p,quietEnabled:true,quietEnd:'22:00'}),/別の時刻/);
});
test('quiet interval is JST, start inclusive, end exclusive, crossing midnight or daytime',()=>{
 const p={...preferences(),quietEnabled:true};
 for(const [time,quiet] of [['21:59',false],['22:00',true],['00:00',true],['06:59',true],['07:00',false]] as const)
  assert.equal(isQuietTime(p,new Date(`2026-10-09T${time}:00+09:00`)),quiet,time);
 assert.equal(isQuietTime({...p,quietStart:'09:00',quietEnd:'17:00'},new Date('2026-10-09T12:00:00+09:00')),true);
});
test('four-day watch survives group to individual transition, retries, deduplicates, and expires',async()=>{
 const fixture=database(),k=await keys(),{db,sqlite,now,run,date}=fixture;
 try{
  const id=await saveSubscription(db,k.subscription,parsePreferences({}));
  await saveFlightPreferences(db,id,preferences(),await flightViews(db,now));
  const env={DB:db,...k};let calls=0;
  const deliver=async()=>{calls++;return new Response(null,{status:201});};
  assert.equal(await notifyWatchedServices(env,deliver,now),0);
  run('1','C');
  assert.equal(await notifyWatchedServices(env,async()=>new Response(null,{status:503}),now),0);
  assert.equal(await notifyWatchedServices(env,deliver,now),1);
  assert.equal(await notifyWatchedServices(env,deliver,now),0);
  assert.equal(calls,1); // Other group members were never registered.
  run('2','D',false);
  const tomorrow=new Date(`${date}T00:00:00+09:00`);tomorrow.setTime(tomorrow.getTime()-86400000);
  const views=await flightViews(db,tomorrow);
  assert.equal(views.get('member')!.snapshot.scope,'この便の個別評価');
  assert.equal(await notifyWatchedServices(env,deliver,tomorrow),1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM watched_services').get()!.n,1);
  const after=new Date(`${date}T08:01:00+09:00`);
  assert.equal(await notifyWatchedServices(env,deliver,after),0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM watched_services').get()!.n,0);
 }finally{sqlite.close();}
});
test('night changes are suppressed and not replayed in the morning; changed settings persist',async()=>{
 const {sqlite,db,now,run}=database(),k=await keys();
 try{
  const id=await saveSubscription(db,k.subscription,parsePreferences({}));
  const p={...preferences(),quietEnabled:true};
  await saveFlightPreferences(db,id,p,await flightViews(db,now));
  run('1','D');const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
  let calls=0;const deliver=async()=>{calls++;return new Response();};
  await notifyWatchedServices({DB:db,...k},deliver,new Date(`${today}T22:00:00+09:00`));
  await notifyWatchedServices({DB:db,...k},deliver,new Date(Date.parse(`${today}T07:00:00+09:00`)+86400000));
  assert.equal(calls,0);
  const response=await handleRequest(new Request(`https://example.test/api/push/subscriptions?id=${id}`),fetch,{DB:db});
  assert.equal(response.status,200);const data=await response.json() as any;assert.deepEqual(data.preferences,p);assert.equal(data.services.length,1);
 }finally{sqlite.close();}
});
test('watch state blocks concurrent delivery and rejects missing/expired registration',async()=>{
 const {sqlite,db,now,run}=database(),k=await keys();
 try{
  const id=await saveSubscription(db,k.subscription,parsePreferences({}));
  await saveFlightPreferences(db,id,preferences(),await flightViews(db,now));run('1','C');
  let calls=0;const deliver=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return new Response();};
  await Promise.all([notifyWatchedServices({DB:db,...k},deliver,now),notifyWatchedServices({DB:db,...k},deliver,now)]);
  assert.equal(calls,1);
  const response=await handleRequest(new Request('https://example.test/api/push/subscriptions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subscription:k.subscription,flightPreferences:{...preferences(),serviceIds:['missing']}})}),fetch,{DB:db});
  assert.equal(response.status,400);
 }finally{sqlite.close();}
});
test('encrypted payload independently decrypts at the recipient using Web Push framing',async()=>{
 const k=await keys(),payload={body:'午前の集約評価：注意',url:'/?service=member'};
 const encrypted=await encryptPushPayload(k.subscription,payload);
 const salt=encrypted.slice(0,16),size=new DataView(encrypted.buffer,encrypted.byteOffset).getUint32(16),keySize=encrypted[20]!;
 assert.equal(size,4096);assert.equal(keySize,65);
 const sender=encrypted.slice(21,21+keySize);
 const senderKey=await crypto.subtle.importKey('raw',sender,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=await crypto.subtle.deriveBits({name:'ECDH',public:senderKey},k.receiver.privateKey,256);
 const enc=new TextEncoder(),receiver=Buffer.from(k.subscription.keys.p256dh,'base64url');
 const hkdf=async(secret:BufferSource,salt:BufferSource,info:BufferSource,length:number)=>{
  const key=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);
  return crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8);
 };
 const ikm=await hkdf(shared,Buffer.from(k.subscription.keys.auth,'base64url'),Buffer.concat([enc.encode('WebPush: info\0'),receiver,sender]),32);
 const cek=await hkdf(ikm,salt,enc.encode('Content-Encoding: aes128gcm\0'),16);
 const nonce=await hkdf(ikm,salt,enc.encode('Content-Encoding: nonce\0'),12);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,encrypted.slice(21+keySize)));
 assert.equal(plain.at(-1),2);assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0,-1))),payload);
});

test('failed group refresh keeps the watch; invalid push endpoints are removed on delivery',async()=>{
 const {sqlite,db,now,run}=database(),k=await keys();
 try{
  const id=await saveSubscription(db,k.subscription,parsePreferences({}));
  await saveFlightPreferences(db,id,preferences(),await flightViews(db,now));
  run('1','C',true,'unavailable');let sends=0;
  assert.equal(await notifyWatchedServices({DB:db,...k},async()=>{sends++;return new Response();},now),0);
  assert.equal(sends,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM watched_services').get()!.n,1);
  run('2','D');
  assert.equal(await notifyWatchedServices({DB:db,...k},async()=>new Response(null,{status:410}),now),0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()!.n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM watched_services').get()!.n,0);
 }finally{sqlite.close();}
});

test('each bell saves and removes only its own flight and preserves other preferences',async()=>{
 const {sqlite,db,now,run}=database(),k=await keys();
 try{
  const id=await saveSubscription(db,k.subscription,parsePreferences({})),views=await flightViews(db,now);
  await saveWatchedService(db,id,'member',preferences(),views);
  const other={...preferences(),serviceIds:['other'],grades:['A'] as ['A'],quietEnabled:true,quietStart:'00:00',quietEnd:'23:59'};
  await saveWatchedService(db,id,'other',other,views);
  const saved=await readFlightPreferences(db,id);assert.equal(saved!.services.length,2);
  assert.deepEqual(saved!.services.find(s=>s.serviceId==='other')!.preferences.grades,['A']);
  run('1','D');let calls=0;
  assert.equal(await notifyWatchedServices({DB:db,...k},async()=>{calls++;return new Response();},now),1);assert.equal(calls,1);
  await saveWatchedService(db,id,'member',{...preferences(),grades:['D']},await flightViews(db,now));
  assert.deepEqual((await readFlightPreferences(db,id))!.services.find(s=>s.serviceId==='other')!.preferences,other);
  await removeWatchedService(db,id,'member');assert.deepEqual((await readFlightPreferences(db,id))!.preferences.serviceIds,['other']);
 }finally{sqlite.close();}
});


test('watched flights share the daily port independently of individual and group ports',async()=>{
 const {sqlite,db,date,now,run}=database();
 try{
  run('1','A');
  let views=await flightViews(db,now);
  assert.equal(views.get('member')!.snapshot.port,null);
  sqlite.prepare("INSERT INTO daily_forecasts(forecast_run_id,service_date,assessment_json,ai_status,created_at) VALUES(?,?,?,'generated',?)").run('1',date,JSON.stringify({date,evaluation_grade:'A',assessment:'総評',port_prediction:'元町',port_confidence_level:2,port_reasons:[]}),now.toISOString());
  views=await flightViews(db,now);
  assert.equal(views.get('member')!.snapshot.port,'元町');
  assert.equal(views.get('other')!.snapshot.port,'元町');
 }finally{sqlite.close();}
});
