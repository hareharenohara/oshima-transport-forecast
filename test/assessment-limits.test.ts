import test from "node:test";
import assert from "node:assert/strict";
import { validateDailyAssessment } from "../src/pipeline/daily-assessment.js";
import { assessBatchWithProviderFallback } from "../src/ai/provider.js";
import { assessGroqDaily } from "../src/groq/client.js";

const date="2026-10-08";
const text="風と波は基準未満のため就航寄りです。"+"🌊".repeat(210);
const service={evaluation_grade:"B",confidence_level:3,confidence_reasons:["AI判断"],assessment:text,positive_factors:["風".repeat(31),"波","うねり"],negative_factors:["波".repeat(31),"風","予報差"],port_prediction:"岡田",port_confidence_level:2,port_reasons:["港の風を比較しました。"+"港".repeat(61),"降水も考慮しました。"]};
const daily={date,port_prediction:"岡田",port_confidence_level:2,port_reasons:service.port_reasons,evaluation_grade:"B",confidence_level:3,confidence_reasons:["AI判断"],assessment:text};
function clock(){let time=0;return{now:()=>time,sleep:async(ms:number)=>{time+=ms;}};}
const input={service:{shipType:"jet",direction:"to_oshima"},forecasts:{weather:[{model:"MSM",phases:{departure:{wind_speed_10m:3},route:{wind_speed_10m:3},arrival:{wind_speed_10m:3}}}],marine:[{model:"Wave",phases:{departure:{wave_height:.4},route:{wave_height:.4},arrival:{wave_height:.4}}}]},officialCriteria:[]};

test("daily overlength prose is preserved without truncation",()=>{
 assert.equal(validateDailyAssessment(daily,date).assessment,text);
});

test("individual, daily and factor length or count excesses are accepted on the first request",async()=>{
 for(const withDaily of [false,true]){
  let calls=0;
  const items=['a','b'].map(serviceId=>({serviceId,input,ml:{},...(withDaily?{dailyDate:date}:{})}));
  const results=await assessBatchWithProviderFallback(items,{groqApiKey:'offline'},async(_url,init)=>{
   calls++;
   const prompt=JSON.parse(String(init?.body)).messages[1].content;
   assert.match(prompt,/120文字程度/);
   assert.ok(!prompt.includes('文字以内'));
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({services:items.map(item=>({service_id:item.serviceId,...service})),...(withDaily?{daily}:{})})}}]});
  },clock());
  assert.equal(calls,1);
  for(const result of results){
   assert.equal(result.aiStatus,'generated');
   assert.equal(result.ai!.assessment,text);
   assert.deepEqual(result.ai!.positive_factors,service.positive_factors);
   assert.deepEqual(result.ai!.negative_factors,service.negative_factors);
   assert.equal(result.ai!.port_reasons,undefined);
   if(withDaily)assert.deepEqual(result.daily!.port_reasons,service.port_reasons);
   if(withDaily)assert.equal(result.daily!.assessment,text);
  }
 }
});

test("aggregate overlength prose and daily recovery are preserved",async()=>{
 const members=[{serviceId:'a',input}];
 let calls=0;
 const results=await assessBatchWithProviderFallback([{serviceId:'group:a',input:{members},ml:{},dailyDate:date}],{groqApiKey:'offline'},async()=>{
  calls++;
  return Response.json({choices:[{message:{content:JSON.stringify({services:[{service_id:'group:a',...service}],daily})}}]});
 },clock());
 assert.equal(calls,1);
 assert.equal(results[0]!.aiStatus,'generated');
 assert.equal(results[0]!.ai!.assessment,text);
 const recovered=await assessGroqDaily([{serviceId:'group:a',input:{members}}],results,date,'offline',async()=>Response.json({choices:[{message:{content:JSON.stringify({daily})}}]}));
 assert.equal(recovered.assessment,text);
});
