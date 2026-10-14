import test from "node:test";
import assert from "node:assert/strict";
import { JUDGMENT_KNOWLEDGE } from "../src/pipeline/judgment-policy.js";
import { buildJudgmentContext } from "../src/forecast/judgment-context.js";
import { packDirectJudgments } from "../src/groq/client.js";
import { validateAssessment } from "../src/gemini/client.js";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";
import type { MultiModelSources } from "../src/forecast/multi-model.js";

function context() {
  const phases = Object.fromEntries(["departure","route","arrival","change3h","change6h"].map(phase => [phase,
    { wind_speed_10m:3, precipitation:0, wave_height:.4, swell_wave_height:.2 }]));
  return {
    service:{shipType:"jet",direction:"to_oshima",scheduledArrivalJst:"2026-10-09T10:00:00+09:00"},
    forecasts:{weather:["MSM","IFS","GFS"].map(model=>({model,phases:structuredClone(phases)})),
      marine:["WAM","Wave"].map(model=>({model,phases:structuredClone(phases)}))},
    officialCriteria:["MSM","IFS","GFS"].map(model=>({criterion:"jet_route_wind",model,forecast:3,threshold:18,unit:"m/s",ratio:3/18,status:"below"})),
    previousPrediction:null as {evaluationGrade:string} | null
  };
}

test("research uncertainty and program decisions survive compression as shared references",()=>{
  const input=context();
  const packed=packDirectJudgments([{serviceId:"group:x",input:{members:[{serviceId:"a",input},{serviceId:"b",input}]}}]);
  const group=packed.services[0]!.input as any;
  assert.equal(packed.definitions.knowledge.experience.sagamiJet[0],17);
  assert.equal(JUDGMENT_KNOWLEDGE.itemEvidence.length,15);
  assert.match(packed.definitions.knowledge.evidenceLimit,/全項目review_required/);
  assert.match(JUDGMENT_KNOWLEDGE.evidenceLimit,/review_required/);
  assert.equal(group.members[0].input.j,group.members[1].input.j);
  const basis=packed.definitions.judgments[group.members[0].input.j] as any[];
  assert.equal(basis[1],null);
  assert.equal(basis[0]&3,3);
  const comparisons=packed.definitions.comparisonSets[group.members[0].input.officialCriteria] as number[];
  assert.ok(comparisons.every(index=>Array.isArray(packed.definitions.comparisonRows[index])));
});

test("Sagami experience uses the Sagami interval, not a high Tokyo harbour maximum or a large-ship threshold",()=>{
  const start=Date.parse("2026-10-09T08:00:00+09:00");
  const rows=["tokyo_port","sagami_north","sagami_central","oshima_north_okata","oshima_west_motomachi"].flatMap(locationId=>
    [0,1,2].map(hour=>({locationId,timestampMs:start+hour*3_600_000,values:{wind_speed_10m:locationId==="tokyo_port"?40:7,wave_height:2}})));
  const sources={weather:[{model:{label:"MSM"},rows}],marine:[{model:{label:"WAM"},rows}],failures:[]} as unknown as MultiModelSources;
  const service={serviceId:"a",voyageNumber:"1",shipType:"jet" as const,direction:"to_oshima" as const,counterpartTerminal:"東京",scheduledDepartureJst:"2026-10-09T08:00:00+09:00",scheduledArrivalJst:"2026-10-09T10:00:00+09:00"};
  const input=buildJudgmentContext(service,{},sources);
  assert.equal(input.experienceCriteria.find(row=>row.criterion==="nakamura_sagami_wind")?.forecast,7);
  assert.equal(input.experienceCriteria.every(row=>!row.reached),true);
  assert.equal(buildJudgmentContext({...service,shipType:"large"},{},sources).experienceCriteria.length,0);
});

function assessment(grade="B") {
 return validateAssessment({evaluation_grade:grade,confidence_level:3,assessment:"条件を総合して判断しました。",
  positive_factors:[],negative_factors:[],confidence_reasons:["AIの判断理由"],official_criteria_status:[],
  port_prediction:"元町",port_confidence_level:3,port_reasons:[],summary:"条件を総合して判断しました。"});
}

test('AI grades, confidence and prose survive missing models, disagreement and prior grade changes',async()=>{
 const missing=context();missing.forecasts.marine=[];missing.previousPrediction={evaluationGrade:'C'};
 const mixed=context();mixed.officialCriteria[0]!.status='reached';mixed.officialCriteria[0]!.forecast=20;
 const items=[{serviceId:'a',input:missing,ml:{}},{serviceId:'d',input:mixed,ml:{}},
  {serviceId:'group:a',input:{members:[{serviceId:'x',input:missing},{serviceId:'y',input:mixed}]},ml:{}}];
 let calls=0,time=0;
 const result=await assessBatchWithProviderFallback(items,{groqApiKey:'mock'},async(_url,init)=>{
  calls++;
  const prompt=JSON.parse(String(init?.body)).messages[1].content;
  assert.ok(!prompt.includes('allowedGrades'));
  assert.ok(!prompt.includes('確信度4/5不可'));
  const packed=JSON.parse(prompt.split('判断材料:\n')[1]);
  assert.ok(packed.services.every((row:any)=>!('allowedGrades' in row.input)));
  return Response.json({choices:[{message:{content:JSON.stringify({services:packed.services.map((row:any)=>({service_id:row.serviceId,...assessment(row.serviceId==='d'?'D':'A')}))})}}]});
 },{now:()=>time,sleep:async(ms)=>{time+=ms;}});
 assert.equal(calls,1);
 assert.deepEqual(result.map(row=>row.aiStatus),['generated','generated','generated']);
 assert.deepEqual(result.map(row=>row.ai!.evaluation_grade),['A','D','A']);
 for(const row of result){
  assert.equal(row.ai!.confidence_level,3);assert.equal(row.ai!.port_confidence_level,undefined);
  assert.deepEqual(row.ai!.confidence_reasons,['AIの判断理由']);
  assert.equal(row.ai!.assessment,'条件を総合して判断しました。');
  assert.equal(row.ai!.port_reasons,undefined);
 }
});

test('short labels and uncertainty statements are accepted without content retries for services and daily prose',async()=>{
 for(const text of ['見込','判断できません','保留','']){
  let calls=0,time=0;
  const result=await assessBatchWithProviderFallback([{serviceId:'a',input:context(),ml:{},dailyDate:'2026-10-10'}],{groqApiKey:'mock'},async()=>{
   calls++;
   return Response.json({choices:[{message:{content:JSON.stringify({services:[{service_id:'a',...assessment(),assessment:text}],daily:{date:'2026-10-10',port_prediction:'元町',port_confidence_level:1,port_reasons:[],evaluation_grade:'A',assessment:text}})}}]});
  },{now:()=>time,sleep:async(ms)=>{time+=ms;}});
  assert.equal(calls,1);assert.equal(result[0]!.aiStatus,'generated');
  assert.equal(result[0]!.ai!.assessment,text);assert.equal(result[0]!.daily!.assessment,text);
 }
});

test('missing confidence fields still trigger a bounded format retry',async()=>{
 let calls=0,time=0;
 const result=await assessBatchWithProviderFallback([{serviceId:'a',input:context(),ml:{}}],{groqApiKey:'mock'},async()=>{
  calls++;
  const value:any={service_id:'a',...assessment()};delete value.confidence_level;
  return Response.json({choices:[{message:{content:JSON.stringify({services:[value]})}}]});
 },{now:()=>time,sleep:async(ms)=>{time+=ms;}});
 assert.equal(calls,2);assert.equal(result[0]!.aiStatus,'unavailable');assert.match(result[0]!.error!,/confidence_level/);
});