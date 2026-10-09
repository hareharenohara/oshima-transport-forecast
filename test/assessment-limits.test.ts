import test from "node:test";
import assert from "node:assert/strict";
import { characterCount, validateAssessmentLimits, validateTextLength } from "../src/pipeline/assessment-limits.js";
import { validateAssessment } from "../src/gemini/client.js";
import { validateDailyAssessment } from "../src/pipeline/daily-assessment.js";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";

const date="2026-10-08";
const service={evaluation_grade:"A",assessment:"風と波は基準未満のため就航寄りと判断します。",positive_factors:[],negative_factors:[],port_prediction:"岡田",port_confidence_level:2,port_reasons:["大島側の風と降水を考慮します。"]};
const daily={date,evaluation_grade:"A",assessment:"風と波の懸念は一部の航路に限られるため、一日全体は就航寄りと判断します。"};
const full=(extra:object={})=>validateAssessment({...service,confidence_level:2,confidence_reasons:[],official_criteria_status:[],summary:service.assessment,...extra});
function clock(){let time=0;return{now:()=>time,sleep:async(ms:number)=>{time+=ms;}};}
function response(ids:string[],a:object=service,d:object=daily){return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({services:ids.map(service_id=>({service_id,...a})),daily:d})}}]});}

test("Unicode character limits accept exact boundaries and reject the next character without truncation",()=>{
 assert.equal(characterCount("波🌊"),2);
 const exact=full({assessment:"波".repeat(120),positive_factors:["風".repeat(30),"波".repeat(30)],negative_factors:["風".repeat(30),"波".repeat(30)],port_reasons:["港".repeat(60)]});
 assert.doesNotThrow(()=>validateAssessmentLimits(exact));
 assert.equal(exact.assessment.length,120);
 for(const extra of [{assessment:"波".repeat(121)},{positive_factors:["風".repeat(31)]},{negative_factors:["波".repeat(31)]},{port_reasons:["港".repeat(61)]},
  {positive_factors:["風","波","うねり"]},{negative_factors:["風","波","うねり"]},{port_reasons:["風","波"]}])
  assert.throws(()=>validateAssessmentLimits(full(extra)),/Assessment length limit/);
 assert.doesNotThrow(()=>validateTextLength("🌊".repeat(120),120,"assessment"));
 assert.throws(()=>validateTextLength("🌊".repeat(121),120,"assessment"),/121 characters/);
 const text="波の予報から就航寄りと判断します。"+"穏".repeat(200-"波の予報から就航寄りと判断します。".length);
 assert.equal(validateDailyAssessment({...daily,assessment:text},date).assessment,text);
 assert.throws(()=>validateDailyAssessment({...daily,assessment:text+"穏"},date),/daily.assessment/);
});

test("an oversized service is rewritten once while another valid result is preserved",async()=>{
 const calls:string[][]=[];
 const results=await assessBatchWithProviderFallback(["a","b"].map(serviceId=>({serviceId,input:{},ml:{},dailyDate:date})),{groqApiKey:"offline"},async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const packed=JSON.parse(body.messages[1].content.split("判断材料:\n")[1]);
  const ids=packed.services.map((row:any)=>row.serviceId);calls.push(ids);
  assert.match(body.messages[1].content,/120文字以内/);assert.match(body.messages[1].content,/200文字以内/);
  if(calls.length===1)return Response.json({choices:[{message:{content:JSON.stringify({services:ids.map((service_id:string)=>({service_id,...service,assessment:service_id==='a'?"波".repeat(121):service.assessment})),daily})}}]});
  assert.match(body.messages[1].content,/Assessment length limit/);
  return response(ids);
 },clock());
 assert.deepEqual(calls,[["a","b"],["a"]]);
 assert.ok(results.every(row=>row.aiStatus==='generated'));
 assert.equal(results[0]!.ai!.assessment,service.assessment);
 assert.equal(results[1]!.ai!.assessment,service.assessment);
 assert.equal(results[0]!.daily!.assessment,daily.assessment);
});

test("an oversized daily overview retries the complete day once with the same IDs",async()=>{
 const calls:string[][]=[];
 const results=await assessBatchWithProviderFallback(["a","b"].map(serviceId=>({serviceId,input:{},ml:{},dailyDate:date})),{groqApiKey:"offline"},async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const ids=JSON.parse(body.messages[1].content.split("判断材料:\n")[1]).services.map((row:any)=>row.serviceId);calls.push(ids);
  if(calls.length===2)assert.match(body.messages[1].content,/daily.assessment/);
  return response(ids,service,calls.length===1?{...daily,assessment:daily.assessment+"波".repeat(200)}:daily);
 },clock());
 assert.deepEqual(calls,[["a","b"],["a","b"]]);
 assert.ok(results.every(row=>row.aiStatus==='generated'&&row.daily?.assessment===daily.assessment));
});

test("persistent length violations stop after one rewrite attempt",async()=>{
 for(const dailyFailure of [false,true]){
  let calls=0;
  const results=await assessBatchWithProviderFallback([{serviceId:"a",input:{},ml:{},dailyDate:date}],{groqApiKey:"offline"},async()=>{
   calls++;return response(["a"],dailyFailure?service:{...service,assessment:"波".repeat(121)},dailyFailure?{...daily,assessment:daily.assessment+"波".repeat(200)}:daily);
  },clock());
  assert.equal(calls,dailyFailure?4:2);
  if(dailyFailure){assert.equal(results[0]!.daily,null);assert.equal(results[0]!.aiStatus,"generated");}
  else{assert.equal(results[0]!.ai,null);assert.match(results[0]!.error!,/Assessment length limit/);}
 }
});
