import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { readRunPushAssessments } from '../src/storage/d1.js';
import { handleRequest } from '../src/worker/index.js';
import { notifyPredictionChanges,notifyOfficialStatusChanges } from '../src/notifications/push.js';

function database(){
 const sqlite=new DatabaseSync(':memory:');
 for(const name of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
 const db={prepare(sql:string){let values:unknown[]=[];return{bind(...args:unknown[]){values=args;return this;},async all(){return{results:sqlite.prepare(sql).all(...values as [])};},async first(){return sqlite.prepare(sql).get(...values as [])??null;},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...values as []).changes)}};}};}} as unknown as D1Database;
 const date=new Date(Date.now()+2*86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
 sqlite.prepare(`INSERT INTO services(id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at) VALUES('member',?,'1','jet','東京','大島','東京',?,?,120,'old','old')`).run(date,`${date}T08:00:00+09:00`,`${date}T10:00:00+09:00`);
 sqlite.exec(`INSERT INTO forecast_runs(id,run_slot,run_at,status,created_at,completed_at) VALUES('old','2000-01-01','old','completed','old','2000-01-01T00:00:00Z'),('new','2000-01-02','new','completed','new','2000-01-02T00:00:00Z');
 INSERT INTO ai_predictions(id,forecast_run_id,service_id,ai_status,created_at) VALUES('old-ai','old','member','unavailable','2000-01-01T00:00:00Z'),('new-ai','new','member','unavailable','2000-01-02T00:00:00Z');
 INSERT INTO ml_predictions(id,forecast_run_id,service_id,cancellation_probability,operation_probability,model_version,features_version,weather_model,marine_model,created_at) VALUES('ml','new','member',.2,.8,'model','features','W','M','new');`);
 const assessment=(port:string)=>JSON.stringify({evaluation_grade:'A',port_prediction:port});
 for(const [run,port] of [['old','元町'],['new','岡田']] as const)sqlite.prepare(`INSERT INTO group_forecasts(forecast_run_id,group_id,service_date,horizon_days,label,ship_type,member_ids_json,assessment_json,ai_status,model,prompt_version,created_at) VALUES(?,?,?,2,'午前・東京航路','jet','["member"]',?,'generated','model','test',?)`).run(run,`group:${run}`,date,assessment(port),run);
 return{sqlite,db,date};
}

test('daily ports reach both current and previous notification comparisons',async()=>{
 const {sqlite,db,date}=database();
 try{
 for(const [run,port] of [['old','元町'],['new','岡田']] as const)sqlite.prepare("INSERT INTO daily_forecasts(forecast_run_id,service_date,assessment_json,ai_status,created_at) VALUES(?,?,?,'generated',?)").run(run,date,JSON.stringify({port_prediction:port}),run);
  const rows=await readRunPushAssessments(db,'new');assert.equal(rows[0]!.result.ai?.port_prediction,'岡田');
  let previousPort:unknown;
  const observer={prepare(sql:string){const statement=db.prepare(sql);return{...statement,bind(...args:unknown[]){const bound=statement.bind(...args);return{...bound,async first(){const result=await bound.first<any>();previousPort=result?.port_prediction;return result;}};}};}} as unknown as D1Database;
  await notifyPredictionChanges({DB:observer,VAPID_PUBLIC_KEY:'configured',VAPID_PRIVATE_KEY:'configured',VAPID_SUBJECT:'mailto:test@example.test'},rows[0]!.service,rows[0]!.result,async()=>{throw Error('No subscribers; must not send');});
  assert.equal(previousPort,'元町');
 }finally{sqlite.close();}
});

test('failed AI updates do not advance the successful-update timestamp',async()=>{
 const {sqlite,db,date}=database();
 try{
  sqlite.exec(`UPDATE group_forecasts SET ai_status='unavailable',assessment_json=NULL WHERE forecast_run_id='new';`);
  const response=await handleRequest(new Request(`https://example.test/api/days?from=${date}`),fetch,{DB:db});
  const data=await response.json() as any;
  assert.equal(data.days[0].ai_update_status,'failed');assert.equal(data.days[0].last_updated_at,null);
  assert.equal(data.days[0].group_forecasts.length,1);
 }finally{sqlite.close();}
});

test('official notification preferences avoid delivery when no subscriber opted in',async()=>{
 const {sqlite,db}=database();
 try{
  let sends=0;
  assert.equal(await notifyOfficialStatusChanges({DB:db,VAPID_PUBLIC_KEY:'configured',VAPID_PRIVATE_KEY:'configured',VAPID_SUBJECT:'mailto:test@example.test'},async()=>{sends++;return new Response();}),0);
  assert.equal(sends,0);
 }finally{sqlite.close();}
});

test('failed group refresh keeps its previous complete forecast and publication date',async()=>{
 const {sqlite,db,date}=database();
 try{
  sqlite.exec(`UPDATE group_forecasts SET group_id='group:old',ai_status='unavailable',assessment_json=NULL WHERE forecast_run_id='new';`);
  const response=await handleRequest(new Request(`https://example.test/api/days?from=${date}`),fetch,{DB:db});
  const data=await response.json() as any;const day=data.days[0];
  assert.equal(day.group_forecasts.length,1);assert.equal(day.group_forecasts[0].assessment.port_prediction,'元町');
  assert.equal(day.group_forecasts[0].stale,true);assert.equal(day.group_forecasts[0].latest_ai_status,'unavailable');
  assert.equal(day.last_updated_at,'2000-01-01T00:00:00Z');assert.equal(day.ai_update_status,'partial');
 }finally{sqlite.close();}
});
