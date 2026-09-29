import test from "node:test"; import assert from "node:assert/strict";
import { compareModels } from "../src/forecast/model-comparison.js";
import { assessWithFallback, validateAssessment, validateForecastSummary } from "../src/gemini/client.js";
test("compares forecast models",()=>{const x=compareModels([{model:"MSM",value:10},{model:"ECMWF",value:12},{model:"GFS",value:11}],2,5);assert.equal(x.mean,11);assert.equal(x.agreement,"high");assert.ok(x.stddev>0)});
test("validates final assessment",()=>{assert.equal(validateAssessment({operation_probability:40,confidence:50,assessment:"注意",positive_factors:[],negative_factors:["波"],confidence_reasons:[],port_prediction:"岡田",summary:"注意"}).confidence,50)});
test("validates forecast summary",()=>{assert.equal(validateForecastSummary({risk_level:"low",model_agreement:"high",key_signals:["低リスク"],missing_data:[],numerical_summary:"2モデルの平均欠航リスク1%"}).risk_level,"low")});
test("runs Gemini summary before final assessment",async()=>{
  const called:string[]=[];
  const mockFetch:typeof fetch=async(input)=>{
    const url=String(input); called.push(url);
    const output=url.includes("flash-lite")
      ? {risk_level:"low",model_agreement:"high",key_signals:["低リスク"],missing_data:[],numerical_summary:"平均1%"}
      : {operation_probability:90,confidence:70,assessment:"運航見込み",positive_factors:["低リスク"],negative_factors:[],confidence_reasons:["モデル一致"],port_prediction:"不明",summary:"運航可能性が高い"};
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}]});
  };
  const x=await assessWithFallback({comparison:{}},{predictions:[]},"x",mockFetch);
  assert.equal(x.aiStatus,"generated"); assert.equal(x.ai?.operation_probability,90); assert.equal(x.forecastSummary?.risk_level,"low");
  assert.match(called[0]!,/gemini-3\.5-flash-lite/); assert.match(called[1]!,/gemini-3\.8-flash/);
});
test("preserves the validated summary when final Gemini is unavailable",async()=>{
  let calls=0;
  const x=await assessWithFallback({}, {predictions:[]}, "x", async()=>{
    calls++;
    if(calls===1)return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({risk_level:"medium",model_agreement:"low",key_signals:[],missing_data:["MSM"],numerical_summary:"モデル差あり"})}]}}]});
    return new Response("unavailable",{status:503});
  });
  assert.equal(x.aiStatus,"unavailable"); assert.equal(x.ai,null); assert.equal(x.forecastSummary?.risk_level,"medium"); assert.equal(calls,3);
});
test("Gemini failure preserves ML fallback",async()=>{const x=await assessWithFallback({}, {cancellationProbability:.2}, "x", async()=>new Response("bad",{status:500}));assert.equal(x.ai,null);assert.equal(x.aiStatus,"unavailable");assert.deepEqual(x.ml,{cancellationProbability:.2})});
test("Gemini retry preserves the final response diagnostic",async()=>{
  let calls=0;
  const x=await assessWithFallback({}, {}, "x", async()=>{calls++;return new Response('{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}',{status:429,headers:{"retry-after":"0"}})});
  assert.equal(calls,2);
  assert.match(x.error??"",/RESOURCE_EXHAUSTED/);
  assert.match(x.error??"",/quota exceeded/);
});
test("accepts valid zero and one-hundred percent boundary assessments",()=>{
  for(const value of [0,100]){
    const result=validateAssessment({operation_probability:value,confidence:value,assessment:"境界値",positive_factors:[],negative_factors:[],confidence_reasons:[],port_prediction:"不明",summary:"境界値確認"});
    assert.equal(result.operation_probability,value); assert.equal(result.confidence,value);
  }
});
test("rejects assessment values outside the percentage range",()=>{
  assert.throws(()=>validateAssessment({operation_probability:101,confidence:50,assessment:"不正",positive_factors:[],negative_factors:[],confidence_reasons:[],port_prediction:"不明",summary:"不正"}),/operation_probability/);
});
