import test from "node:test";
import assert from "node:assert/strict";
import {assessBatchWithProviderFallback} from "../src/ai/provider.js";
import {pacedGroqFetch} from "../src/groq/rate-limit.js";
const assessment={evaluation_grade:"A",assessment:"風速と波高は基準未満ですが、予報モデルの差と今後の変化に注意が必要です。",positive_factors:["風速・波高が基準未満","モデル一致"],negative_factors:[],port_prediction:"元町",port_confidence_level:1,port_reasons:[]};
function clock(){let time=0;return{now:()=>time,sleep:async(ms:number)=>{time+=ms;}};}

test("truncated valid JSON is split and regenerated, preserving all target IDs and detailed text",async()=>{
 const sent:string[][]=[];
 const results=await assessBatchWithProviderFallback(["a","b"].map(serviceId=>({serviceId,input:{},ml:{serviceId}})),{groqApiKey:"offline"},async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  const packed=JSON.parse(body.messages[1].content.split("判断材料:\n")[1]);
  const ids=packed.services.map((row:any)=>row.serviceId);sent.push(ids);
  return Response.json({choices:[{finish_reason:ids.length>1?"length":"stop",message:{content:JSON.stringify({services:ids.map((service_id:string)=>({service_id,...assessment}))})}}]});
 },clock());
 assert.deepEqual(sent,[["a","b"],["a"],["b"]]);
 assert.deepEqual(results.map(row=>row.aiStatus),["generated","generated"]);
 assert.deepEqual(results.map(row=>row.ml.serviceId),["a","b"]);
 assert.equal(results[0]!.ai!.assessment,assessment.assessment);
 assert.equal(results[0]!.ai!.positive_factors.length,2);
 assert.ok(results[0]!.aiAudit.attempts.some(row=>row.finishReason==="length"));
});

test("single truncated assessment expands its budget only once, and repeated truncation remains unavailable",async()=>{
 for(const persistent of [false,true]){
  const budgets:number[]=[];
  const result=await assessBatchWithProviderFallback([{serviceId:"a",input:{},ml:{}}],{groqApiKey:"offline"},async(_url,init)=>{
   const body=JSON.parse(String(init?.body));budgets.push(body.max_completion_tokens);
   return Response.json({choices:[{finish_reason:persistent||budgets.length===1?"length":"stop",message:{content:JSON.stringify({services:[{service_id:"a",...assessment}]})}}]});
  },clock());
  assert.deepEqual(budgets,[1600,3200]);
  assert.equal(result[0]!.aiStatus,persistent?"unavailable":"generated");
  if(persistent){assert.equal(result[0]!.ai,null);assert.match(result[0]!.error!,/phase=completion_limit/);}
 }
});

test("request with too little output space is rejected before sending rather than silently shortening completion",async()=>{
 let calls=0;
 const send=pacedGroqFetch(async()=>{calls++;return Response.json({});},clock());
 const init={body:JSON.stringify({model:"openai/gpt-oss-120b",messages:[{content:"x".repeat(17000)}],max_completion_tokens:1600})};
 await assert.rejects(send("https://api.groq.com",init),/insufficient completion budget/);
 assert.equal(calls,0);
});
