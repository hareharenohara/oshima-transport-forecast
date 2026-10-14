import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { groupForecastServices } from "../src/pipeline/forecast-groups.js";
import { assessServicesBatch } from "../src/pipeline/assessment.js";
import { packDirectJudgments } from "../src/groq/client.js";
import { readGroupForecasts, saveGroupAssessment } from "../src/storage/d1.js";
import { FORECAST_POINTS } from "../src/config/forecast-points.js";
import { MARINE_VARIABLES, WEATHER_VARIABLES } from "../src/forecast/open-meteo.js";
import { fetchMultiModelSources } from "../src/forecast/multi-model.js";
import type { ServiceInput } from "../src/types.js";

const now=new Date("2026-10-07T00:00:00+09:00");
function daily(day:number):ServiceInput[]{
 const date=`2026-10-${String(7+day).padStart(2,"0")}`,services:ServiceInput[]=[];
 for(const hour of [8,14])for(const route of ["東京","熱海"])for(const direction of ["to_oshima","from_oshima"] as const)
  services.push({serviceId:`${day}-${hour}-${route}-${direction}`,voyageNumber:"1",shipType:"jet",direction,counterpartTerminal:route,
   scheduledDepartureJst:`${date}T${String(hour).padStart(2,"0")}:00:00+09:00`,scheduledArrivalJst:`${date}T${hour+2}:00:00+09:00`});
 for(const direction of ["to_oshima","from_oshima"] as const)services.push({serviceId:`${day}-large-${direction}`,voyageNumber:"2",shipType:"large",direction,counterpartTerminal:"東京",scheduledDepartureJst:`${date}T10:00:00+09:00`,scheduledArrivalJst:`${date}T18:00:00+09:00`});
 return services;
}
const assessment={evaluation_grade:"B",confidence_level:2,assessment:"波の基準比較とモデル差を考慮して判断が分かれる見込みです。",positive_factors:[],negative_factors:[],confidence_reasons:[],official_criteria_status:[],port_prediction:"岡田",port_confidence_level:1,port_reasons:["降水予報を考慮しました。"],summary:"条件が分かれます。"};

test("50-service horizon groups have 5/3/2 frames without losing members or inventing absent routes",()=>{
 const services=Array.from({length:5},(_,day)=>daily(day)).flat();
 const groups=groupForecastServices(services,now);
 assert.deepEqual([2,3,4].map(day=>groups.filter(group=>group.horizon===day).length),[5,3,2]);
 const members=groups.flatMap(group=>group.members.map(service=>service.serviceId));
 assert.equal(members.length,30);assert.equal(new Set(members).size,30);
 assert.ok(groups.filter(group=>group.horizon===2&&group.shipType==='jet').every(group=>new Set(group.members.map(service=>service.counterpartTerminal)).size===1));
 const extra={...daily(2)[0]!,serviceId:"extra",counterpartTerminal:"伊東"};
 assert.ok(groupForecastServices([extra],now)[0]!.label.includes("伊東"));
 assert.equal(groupForecastServices(daily(0).concat(daily(1)),now).length,0);
});

test("direct packing shares identical matrices while retaining member identity, phase and model",()=>{
 const input={service:{serviceId:"a"},forecasts:{weather:[{model:"JMA MSM",phases:{departure:{wind_speed_10m:0},route:{wind_speed_10m:9},change3h:{wind_speed_10m:-1}}}],marine:[]},officialCriteria:[{criterion:"jet_route_wind",model:"JMA MSM",unit:"m/s",forecast:9,threshold:18,ratio:.5,status:"below"}]};
 const packed=packDirectJudgments([{serviceId:"group:test",input:{scope:"group",label:"午前",members:[{serviceId:"a",input},{serviceId:"b",input:{...input,service:{serviceId:"b"}}}]}}]);
 assert.equal(packed.definitions.matrices.length,1);
 const group=packed.services[0]!.input as any;
 assert.deepEqual(group.members.map((member:any)=>member.serviceId),["a","b"]);
 assert.deepEqual((packed.definitions.matrices[0] as number[]).map(index=>(packed.definitions.matrixRows[index] as number[])[0]),[0,9,null]);
 assert.deepEqual(packed.definitions.criteria,[["jet_route_wind","m/s",18,["w",1,0]]]);
 const comparisons=packed.definitions.comparisonSets[group.members[0].input.officialCriteria] as number[];
 assert.deepEqual(packed.definitions.comparisonRows[comparisons[0]!],[0,0,0]);
});

for(const horizon of [2,3,4])test(`scheduled pipeline judges only day-${horizon} group IDs and preserves per-service ML`,async()=>{
 const times=Array.from({length:168},(_,i)=>new Date(now.getTime()+i*3_600_000).toISOString().slice(0,16));
 let aiCalls=0;
 const mock:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.hostname==='api.groq.com'){
   aiCalls++;const body=JSON.parse(String(init?.body));
   assert.equal(body.model,"openai/gpt-oss-120b");
   assert.ok(body.max_completion_tokens<=1600);
   assert.equal(body.max_completion_tokens,1600, `completion budget ${body.max_completion_tokens} is too small`);
   const packed=JSON.parse(body.messages[1].content.split("判断材料:\n")[1]);
   assert.ok(packed.services.every((s:any)=>s.serviceId.startsWith('group:')));
   assert.ok(packed.services.every((s:any)=>s.input.format==='group-weather-v1'&&!('members' in s.input)));
   assert.equal(packed.services.reduce((sum:number,s:any)=>sum+s.input.coveredServices,0)>0,true);
   return Response.json({choices:[{message:{content:JSON.stringify({services:packed.services.map((s:any)=>({service_id:s.serviceId,...assessment}))})}}],usage:{total_tokens:1000}});
  }
  const variables=url.hostname.startsWith('marine-')?MARINE_VARIABLES:WEATHER_VARIABLES;
  const offset=[...url.search].reduce((sum,c)=>sum+c.charCodeAt(0),0)%13;
  return Response.json(FORECAST_POINTS.map((_,location)=>({hourly:Object.fromEntries([["time",times],...variables.map(variable=>[variable,
    times.map((_,hour)=>variable.includes('direction')?(hour*11+location*23+offset)%360:variable.includes('pressure')?1012+offset:
      variable.includes('period')?7+offset/10:variable.includes('wind_speed')?23+Math.sin(hour)+location/10+offset/10:
      variable.includes('height')?4+Math.cos(hour)+location/10+offset/10:1+offset/10)])])})));
 };
 const sources=await fetchMultiModelSources(mock);
 const services=daily(horizon);
 let clockTime=0;
 const batch=await assessServicesBatch(services,{groqApiKey:'mock'},mock,sources,new Map(),now,{now:()=>clockTime,sleep:async(ms)=>{clockTime+=ms;}});
 assert.equal(batch.failures.length,0);
 assert.equal(batch.grouped.length,horizon===2?5:horizon===3?3:2);
 assert.ok(batch.grouped.every(row=>row.result.aiStatus==='generated'),JSON.stringify(batch.grouped.map(row=>({label:row.group.label,error:row.result.error}))));
 assert.ok(batch.assessed.every(row=>row.result.ai===null&&row.result.ml.predictions.length>0));
 assert.ok(aiCalls<=2);
});

test("group persistence returns only a complete latest published date generation",async()=>{
 const sqlite=new DatabaseSync(':memory:');
 try{
  for(const name of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
  const db={prepare(sql:string){let args:unknown[]=[];return{bind(...values:unknown[]){args=values;return this;},async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...args as []).changes)}};},async all(){return{results:sqlite.prepare(sql).all(...args as [])};}};}} as unknown as D1Database;
  sqlite.exec(`INSERT INTO forecast_runs(id,run_slot,run_at,status,created_at,publish_at) VALUES('old','2000-01-01','old','completed','old',NULL),('new','2000-01-02','new','running','new',NULL);`);
  const groups=groupForecastServices(daily(2),now);
  const result={ml:{predictions:[]},forecastSummary:null,ai:assessment as any,aiStatus:'generated' as const,geminiModels:{summary:'none',final:'openai/gpt-oss-120b'}};
  for(const group of groups)await saveGroupAssessment(db,'old',group,result,'old');
  await saveGroupAssessment(db,'new',groups[0]!,result,'new');
  assert.equal((await readGroupForecasts(db,'2026-10-09',1)).length,5);
  sqlite.exec("UPDATE forecast_runs SET status='completed' WHERE id='new'");
  const latest=await readGroupForecasts(db,'2026-10-09',1);
  assert.equal(latest.length,1);assert.equal(latest[0]!.group_id,groups[0]!.id);
  assert.deepEqual(latest[0]!.member_ids,groups[0]!.members.map(s=>s.serviceId));
 }finally{sqlite.close();}
});

test('group latest-date selection preserves failed fallback, changed membership and publication isolation', async () => {
 const sqlite=new DatabaseSync(':memory:');
 try {
  for(const name of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
  const db={prepare(sql:string){let args:unknown[]=[];return{bind(...values:unknown[]){args=values;return this;},async all(){return{results:sqlite.prepare(sql).all(...args as [])};}};}} as unknown as D1Database;
  sqlite.exec(`INSERT INTO forecast_runs(id,run_slot,run_at,status,created_at,publish_at) VALUES
   ('old','2000-01-01','2000-01-01','completed','old',NULL),
   ('new','2000-01-02','2000-01-02','partial','new',NULL),
   ('future','2000-01-03','2000-01-03','completed','future','2999-01-01'),
   ('running','2000-01-04','2000-01-04','running','running',NULL);`);
  const insert=sqlite.prepare(`INSERT INTO group_forecasts(forecast_run_id,group_id,service_date,horizon_days,label,ship_type,member_ids_json,assessment_json,ai_status,model,prompt_version,created_at) VALUES(?,?,'2026-10-12',2,?,'jet',?,?,?,'test','test',?)`);
  for(const id of ['same','changed','removed'])insert.run('old',id,id,'["a"]',JSON.stringify({evaluation_grade:'A'}),'generated','old');
  insert.run('new','same','same','["a"]',null,'unavailable','new');
  insert.run('new','changed','changed','["b"]',null,'unavailable','new');
  insert.run('future','same','same','["a"]',JSON.stringify({evaluation_grade:'D'}),'generated','future');
  insert.run('running','same','same','["a"]',JSON.stringify({evaluation_grade:'D'}),'generated','running');
  const rows=await readGroupForecasts(db,'2026-10-12',1);
  assert.deepEqual(rows.map(r=>r.group_id),['changed','same']);
  assert.equal(rows[0]!.assessment,null);
  assert.deepEqual(rows[0]!.member_ids,['b']);
  assert.equal(rows[1]!.assessment!.evaluation_grade,'A');
  assert.equal(rows[1]!.latest_ai_status,'unavailable');
  assert.equal(rows[1]!.stale,true);
  assert.equal((await readGroupForecasts(db,'2026-10-13',1)).length,0);
 } finally {sqlite.close();}
});
