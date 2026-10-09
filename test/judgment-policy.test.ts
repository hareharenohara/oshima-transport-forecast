import test from "node:test";
import assert from "node:assert/strict";
import { buildJudgmentBasis, enforceJudgmentPolicy, validateJudgmentComment, JUDGMENT_KNOWLEDGE } from "../src/pipeline/judgment-policy.js";
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

test('natural weather explanations do not require a specific conjunction',()=>{
 const value=validateAssessment({...assessment(),assessment:'風速は基準未満。波高も低く、就航できます。',port_reasons:['弱い風と少ない降水で元町を選択。']});
 assert.doesNotThrow(()=>validateJudgmentComment(value,context()));
 assert.throws(()=>validateJudgmentComment({...value,assessment:'評価保留'},context()),/comment requires/);
 assert.throws(()=>validateJudgmentComment({...value,port_reasons:[]},context()),/comment requires/);
});
function assessment(grade="B") {
  return validateAssessment({evaluation_grade:grade,confidence_level:5,assessment:"風速の予報と基準比較を考慮して就航寄りと判断しました。",
    positive_factors:[],negative_factors:[],confidence_reasons:["AI自己申告"],official_criteria_status:[],
    port_prediction:"元町",port_confidence_level:5,port_reasons:["穏やかな予報"],summary:"就航寄り"});
}

test("confidence is computed independently of grade; uncertainty cannot become high self-reported confidence",()=>{
  const input=context();
  const result=enforceJudgmentPolicy(assessment(),input);
  assert.equal(result.confidence_level,3);
  assert.equal(result.port_confidence_level,3);
  assert.ok(result.confidence_reasons.some(reason=>reason.includes("未検証")));
  input.officialCriteria[0]!.status="reached";
  input.officialCriteria[0]!.forecast=19;
  assert.equal(enforceJudgmentPolicy(assessment("C"),input).confidence_level,2);
  assert.throws(()=>enforceJudgmentPolicy(assessment("A"),input),/A is not supported/);
  assert.throws(()=>enforceJudgmentPolicy(assessment("D"),input),/D is not supported/);
  for(const row of input.officialCriteria){row.status="reached";row.forecast=19;}
  assert.equal(enforceJudgmentPolicy(assessment("D"),input).evaluation_grade,"D");
  assert.equal(enforceJudgmentPolicy(assessment("C"),input).evaluation_grade,"C"); // Not automatically D.
});

test("partial phase data lowers confidence without forcing a cancellation direction",()=>{
  const input=context();input.previousPrediction={evaluationGrade:"C"};
  assert.equal(enforceJudgmentPolicy(assessment("B"),input).confidence_level,2);
  for(const model of input.forecasts.marine)delete (model.phases.arrival! as Record<string,unknown>).wave_height;
  assert.equal(buildJudgmentBasis(input)?.assessable,false);
  assert.equal(enforceJudgmentPolicy(assessment("B"),input).evaluation_grade,"B");
  assert.equal(enforceJudgmentPolicy(assessment("C"),input).evaluation_grade,"C");
  assert.equal(enforceJudgmentPolicy(assessment("B"),input).confidence_level,1);
});

test("group constraints preserve the weakest member and require one actual port",()=>{
  const good=context(),missing=context();missing.forecasts.marine=[];
  assert.equal(enforceJudgmentPolicy(assessment(),{members:[{input:good},{input:missing}]}).evaluation_grade,"B");
  assert.equal(enforceJudgmentPolicy(assessment(),{members:[{input:good},{input:missing}]}).confidence_level,1);
  const unknown={...assessment(),port_prediction:"不明" as const};
  assert.throws(()=>enforceJudgmentPolicy(unknown,good),/must select/);
});

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
  assert.equal(basis[1],3);
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

test("partial weather still reaches the AI and keeps the chosen direction with low confidence",async()=>{
  const missing=context();missing.forecasts.marine=[];
  const items=[{serviceId:"a",input:context(),ml:{value:1}},{serviceId:"missing",input:missing,ml:{value:2}},{serviceId:"b",input:context(),ml:{value:3}}];
  let calls=0;
  const result=await assessBatchWithProviderFallback(items,{groqApiKey:"mock"},async(_url,init)=>{
    calls++;
    const prompt=JSON.parse(String(init?.body)).messages[1].content;
    const packed=JSON.parse(prompt.split("判断材料:\n")[1]);
    assert.deepEqual(packed.services.map((row:any)=>row.serviceId),["a","missing","b"]);
    return Response.json({choices:[{message:{content:JSON.stringify({services:packed.services.map((row:any)=>({service_id:row.serviceId,...assessment()}))})}}]});
  });
  assert.equal(calls,1);
  assert.deepEqual(result.map(row=>row.aiStatus),["generated","generated","generated"]);
  assert.deepEqual(result.map(row=>row.ml.value),[1,2,3]);
});

test("one ungrounded extreme grade is rejected without discarding other valid targets",async()=>{
  const bad=context();bad.officialCriteria[0]!.status="reached";bad.officialCriteria[0]!.forecast=20;
  let clock=0;
  const result=await assessBatchWithProviderFallback([{serviceId:"bad",input:bad,ml:{}},{serviceId:"good",input:context(),ml:{}}],{groqApiKey:"mock"},async(_url,init)=>{
    const packed=JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('判断材料:\n')[1]);
    return Response.json({choices:[{message:{content:JSON.stringify({services:packed.services.map((row:any)=>({service_id:row.serviceId,...assessment(row.serviceId==='bad'?'A':'B')}))})}}]});
  },{now:()=>clock,sleep:async(ms)=>{clock+=ms;}});
  assert.deepEqual(result.map(row=>row.aiStatus),["unavailable","generated"]);
  assert.match(result[0]!.error!,/A is not supported/);
});

test('corrects only rejected targets once without weakening grades or losing valid results',async()=>{
 const bad=context();bad.forecasts.weather.pop();
 let calls=0,time=0;
 const results=await assessBatchWithProviderFallback([{serviceId:'bad',input:bad,ml:{id:1}},{serviceId:'good',input:context(),ml:{id:2}}],{groqApiKey:'mock'},async(_url,init)=>{
  const packed=JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split('判断材料:\n')[1]);calls++;
  if(calls===2){assert.deepEqual(packed.services.map((row:any)=>row.serviceId),['bad']);assert.match(packed.services[0].input.responseCorrection,/A is not supported/);}
  assert.ok(!packed.services.find((row:any)=>row.serviceId==='bad').input.allowedGrades.includes('A'));
  return Response.json({choices:[{message:{content:JSON.stringify({services:packed.services.map((row:any)=>({service_id:row.serviceId,...assessment(row.serviceId==='bad'&&calls===1?'A':'B')}))})}}]});
 },{now:()=>time,sleep:async(ms)=>{time+=ms;}});
 assert.equal(calls,2);assert.deepEqual(results.map(row=>row.aiStatus),['generated','generated']);
 assert.deepEqual(results.map(row=>row.ml.id),[1,2]);assert.equal(results[0]!.ai!.confidence_level,2);
});

test('placeholder comments trigger one bounded retry and cannot be saved as generated',async()=>{
 let calls=0,time=0;
 const result=await assessBatchWithProviderFallback([{serviceId:'a',input:context(),ml:{}}],{groqApiKey:'mock'},async()=>{
  calls++;return Response.json({choices:[{message:{content:JSON.stringify({services:[{service_id:'a',...assessment(),assessment:'評価保留',port_reasons:[]}]})}}]});
 },{now:()=>time,sleep:async(ms)=>{time+=ms;}});
 assert.equal(calls,2);assert.equal(result[0]!.aiStatus,'unavailable');assert.match(result[0]!.error!,/comment requires/);
});
