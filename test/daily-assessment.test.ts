import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";
import { readDailyForecasts, saveDailyAssessment } from "../src/storage/d1.js";
import { handleRequest } from "../src/worker/index.js";
const date="2026-10-08";
const overview={date,evaluation_grade:"A" as const,assessment:"波の懸念は午後の東京航路に限られるため、全体は就航寄りと判断します。"};
const leg={evaluation_grade:"D",assessment:"波高から欠航寄りと判断します。",positive_factors:[],negative_factors:[],port_prediction:"岡田",port_confidence_level:1,port_reasons:["波の予報を考慮"]};
function clock(){let time=0;return{now:()=>time,sleep:async(ms:number)=>{time+=ms;}};}

test("one request per date returns independent daily grade with identical weather transport",async()=>{
 const requests:any[]=[];
 const results=await assessBatchWithProviderFallback(["a","b","c"].map((serviceId,i)=>({serviceId,input:{},ml:{},dailyDate:i<2?date:"2026-10-09"})),{groqApiKey:"offline"},async(_url,init)=>{
  const body=JSON.parse(String(init?.body));requests.push(body);
  const ids=JSON.parse(body.messages[1].content.split("判断材料:\n")[1]).services.map((row:any)=>row.serviceId);
  const day=body.response_format.json_schema.schema.properties.daily.properties.date.enum[0];
  return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({services:ids.map((service_id:string)=>({service_id,...leg})),daily:{...overview,date:day}})}}]});
 },clock());
 assert.equal(requests.length,2);
 assert.equal(results[0]!.ai!.evaluation_grade,"D");assert.equal(results[0]!.daily!.evaluation_grade,"A");
 assert.equal(results[2]!.daily!.date,"2026-10-09");
});

test("missing, wrong-date or placeholder daily output preserves valid service judgments",async()=>{
 for(const daily of [undefined,{...overview,date:"2026-10-09"},{...overview,assessment:"評価保留"}]){
  const results=await assessBatchWithProviderFallback([{serviceId:"a",input:{},ml:{},dailyDate:date}],{groqApiKey:"offline"},async()=>Response.json({choices:[{message:{content:JSON.stringify({services:[{service_id:"a",...leg}],daily})}}]}),clock());
  assert.equal(results[0]!.aiStatus,"generated");assert.equal(results[0]!.daily,null);assert.ok(results[0]!.dailyError);
 }
});

test("a split recovers daily outlook from all targets, never a partial request",async()=>{
 let recoveryTargets:string[]=[];
 const results=await assessBatchWithProviderFallback(["a","b"].map(serviceId=>({serviceId,input:{},ml:{},dailyDate:date})),{groqApiKey:"offline"},async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const ids=JSON.parse(body.messages[1].content.split("判断材料:\n")[1]).services.map((row:any)=>row.serviceId);
  if(!body.response_format.json_schema.schema.properties.services){recoveryTargets=ids;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({daily:overview})}}]});}
  return Response.json({choices:[{finish_reason:ids.length>1?"length":"stop",message:{content:JSON.stringify({services:ids.map((service_id:string)=>({service_id,...leg})),daily:overview})}}]});
 },clock());
 assert.deepEqual(recoveryTargets,["a","b"]);
 assert.ok(results.every(row=>row.aiStatus==="generated"&&row.daily?.evaluation_grade==='A'));
});

test("daily persistence hides running/future generations and retains previous success with an explicit latest failure",async()=>{
 const sqlite=new DatabaseSync(":memory:");
 try{
  for(const name of readdirSync("migrations").filter(name=>name.endsWith(".sql")).sort())sqlite.exec(readFileSync(`migrations/${name}`,"utf8"));
  const db={prepare(sql:string){let args:unknown[]=[];return{bind(...values:unknown[]){args=values;return this;},async run(){sqlite.prepare(sql).run(...args as []);},async first(){return sqlite.prepare(sql).get(...args as []) ?? null;},async all(){return{results:sqlite.prepare(sql).all(...args as [])};}};}} as unknown as D1Database;
  sqlite.exec(`INSERT INTO forecast_runs(id,run_slot,run_at,status,created_at,publish_at) VALUES('old','2000-01-01','old','completed','old',NULL),('new','2000-01-02','new','running','new',NULL);`);
  await saveDailyAssessment(db,"old",{date,assessment:overview},"old");
  await saveDailyAssessment(db,"new",{date,assessment:null,error:"failure"},"new");
  assert.equal((await readDailyForecasts(db,date))[0]!.assessment!.evaluation_grade,"A");
  sqlite.exec("UPDATE forecast_runs SET status='completed',publish_at='2999-01-01' WHERE id='new'");
  assert.equal((await readDailyForecasts(db,date))[0]!.assessment!.evaluation_grade,"A");
  sqlite.exec("UPDATE forecast_runs SET publish_at=NULL WHERE id='new'");
  const latest=(await readDailyForecasts(db,date))[0]!;assert.equal(latest.assessment!.evaluation_grade,"A");assert.equal(latest.ai_status,"generated");assert.equal(latest.latest_ai_status,"unavailable");assert.equal(latest.stale,true);
  sqlite.exec(`INSERT INTO services (id,service_date,service_number,ship_type,origin,destination,counterpart_terminal,scheduled_departure,scheduled_arrival,scheduled_duration_minutes,created_at,updated_at)
    VALUES ('service','2026-10-08','1','jet','東京','大島','東京','2026-10-08T08:00:00+09:00','2026-10-08T10:00:00+09:00',120,'old','old');
    INSERT INTO ai_predictions (id,forecast_run_id,service_id,evaluation_rating,ai_status,created_at) VALUES ('ai','old','service','D','generated','2000-01-01');`);
  sqlite.exec(`INSERT INTO ai_predictions (id,forecast_run_id,service_id,ai_status,created_at) VALUES ('failed','new','service','unavailable','2000-01-02');`);
  const api=await handleRequest(new Request(`https://local/api/days?from=${date}`),async()=>{throw new Error("network forbidden");},{DB:db});
  assert.equal(api.status,200);
  const payload=await api.json() as any;
  assert.equal(payload.days[0].daily_forecast.latest_ai_status,"unavailable");
  assert.equal(payload.days[0].services[0].evaluation_grade,"D");
  assert.equal(payload.days[0].services[0].latest_ai_status,"unavailable");
  assert.equal(payload.days[0].services[0].prediction_created_at,"2000-01-01");
  assert.equal(payload.days[0].ai_update_status,"partial");
 }finally{sqlite.close();}
});

test('compact output schema decodes all target IDs and prose without changing public assessment fields',async()=>{
 const results=await assessBatchWithProviderFallback([{serviceId:'original',input:{},ml:{},dailyDate:date}],{groqApiKey:'offline'},async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.ok(body.response_format.json_schema.schema.properties.services.items.properties.id);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({services:[{id:'original',g:'A',a:leg.assessment,p:[],n:[],o:'岡田',c:1,r:'波の予報を考慮'}],daily:overview})}}]});
 },clock());
 assert.equal(results[0]!.ai!.evaluation_grade,'A');assert.equal(results[0]!.ai!.assessment,leg.assessment);
 assert.deepEqual(results[0]!.aiAudit.attempts[0]!.returnedIds,['original']);
 assert.ok(results[0]!.aiAudit.attempts[0]!.responseText?.includes('original'));
});

test('provider schema-rejected JSON is recovered only after full local validation',async()=>{
 for(const wrongId of [false,true]){
  const results=await assessBatchWithProviderFallback([{serviceId:'a',input:{},ml:{},dailyDate:date}],{groqApiKey:'offline'},async()=>Response.json({error:{code:'json_validate_failed',failed_generation:JSON.stringify({services:[{id:wrongId?'wrong':'a',g:'A',a:leg.assessment,p:'風は基準未満',n:[],o:'岡田',c:1,r:'波の予報を考慮'}],daily:overview})}},{status:400}),clock());
  assert.equal(results[0]!.aiStatus,wrongId?'unavailable':'generated');
  if(!wrongId){assert.deepEqual(results[0]!.ai!.positive_factors,['風は基準未満']);assert.equal(results[0]!.aiAudit.attempts[0]!.status,400);}
 }
});

test("served UI uses daily grade, renders escaped overview before services and opens the card",async()=>{
 const script=await (await handleRequest(new Request("https://local/app.js"))).text();
 const container={innerHTML:""};const button:any={dataset:{date},setAttribute(){},closest:()=>({classList:{toggle:()=>true}})};
 const context=vm.createContext({Intl,Date,Set,document:{querySelector:(s:string)=>s==="#days"?container:{hidden:false},querySelectorAll:(s:string)=>s==="[data-day]"?[button]:[]}});
 // Run only application definitions, before its network initialization.
 vm.runInContext(script.slice(0,script.indexOf("qa('[data-close]')")),context);
 vm.runInContext(`days=[{date:${JSON.stringify(date)},services:[{service_id:'a',evaluation_grade:'D'}],daily_forecast:{action_guidance:{grade:'A'},assessment:${JSON.stringify({...overview,assessment:overview.assessment+"<script>"})}}}];render()`,context);
 assert.match(container.innerHTML,/data-grade="A"/);assert.match(container.innerHTML,/&lt;script&gt;/);
 assert.ok(container.innerHTML.indexOf("総評")<container.innerHTML.indexOf('data-service="a"'));
 assert.equal(typeof button.onclick,"function");button.onclick();
 vm.runInContext(`days[0].daily_forecast={ai_status:'unavailable',assessment:null};render()`,context);
 assert.match(container.innerHTML,/data-grade="pending"/);assert.match(container.innerHTML,/前回予測/);assert.doesNotMatch(container.innerHTML,/data-grade="C"|慎重側/);
});
