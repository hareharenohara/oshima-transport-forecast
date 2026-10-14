import test from "node:test";
import assert from "node:assert/strict";
import {packDirectJudgments,assessGroqBatch} from "../src/groq/client.js";

test("comparison sharing restores each member's own values and keeps distinct-window comparisons explicit",()=>{
 const items=[7,11].map((wind,index)=>({serviceId:`s${index}`,input:{service:{shipType:"jet",direction:"to_oshima",counterpartTerminal:"東京"},
  forecasts:{weather:[{model:"MSM",phases:{departure:{wind_speed_10m:0},route:{wind_speed_10m:wind},arrival:{wind_speed_10m:null}}}],marine:[]},
  officialCriteria:[{criterion:"jet_route_wind",model:"MSM",unit:"m/s",forecast:wind,threshold:18,ratio:wind/18,status:"below"},
   {criterion:"jet_route_wind",model:"MSM",unit:"m/s",forecast:17,threshold:18,ratio:17/18,status:"near_internal"}]}}));
 const before=structuredClone(items),packed=packDirectJudgments(items);
 const decode=(input:any,index:number)=>{
  const row=packed.definitions.comparisonRows[index] as any[];
  const definition=packed.definitions.criteria[row[0]] as any[];
  if(!definition[3])return row[3];
  const [field,phase,column]=definition[3];
  const matrix=(input[field] as number[][]).find(pair=>pair[0]===row[1])![1]!;
  const matrixRows=packed.definitions.matrices[matrix] as number[];
  return (packed.definitions.matrixRows[matrixRows[phase]!] as any[])[column];
 };
 for(let index=0;index<2;index++){
  const input=packed.services[index]!.input as any;
  const comparisons=packed.definitions.comparisonSets[input.officialCriteria] as number[];
  const restored=comparisons.map(reference=>decode(input,reference));
  assert.deepEqual(restored,[17,index===0?7:11]);
  assert.deepEqual(packed.definitions.phases,["d","r","a"]);
  const matrix=packed.definitions.matrices[input.w[0][1]] as number[];
  assert.equal((packed.definitions.matrixRows[matrix[0]!] as any[])[0],0);
  assert.equal((packed.definitions.matrixRows[matrix[2]!] as any[])[0],null);
 }
 assert.deepEqual(items,before);
});

test("compact API output rebuilds display fields while requesting AI confidence and omitting duplicate summary",async()=>{
 const result=await assessGroqBatch([{serviceId:"a",input:{officialCriteria:[]},ml:{}}],"offline",async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  assert.match(body.messages[1].content,/入港基準を航路途中の基準で置き換えない/);
  assert.match(body.messages[1].content,/モデル差・拮抗・欠損だけでBにもCにも固定せず/);
  assert.match(body.messages[1].content,/同じ地点・運航時間帯に関する入力上の具体的根拠/);
  const properties=body.response_format.json_schema.schema.properties.services.items.properties;
  for(const key of ["official_criteria_status","summary"])assert.equal(key in properties,false);
  for(const key of ["confidence_level","confidence_reasons"])assert.equal(key in properties,true);
  assert.equal(properties.confidence_level.maximum,3);assert.equal(properties.port_confidence_level,undefined);
  for(const key of ["positive_factors","negative_factors"])assert.equal(properties[key].maxItems,undefined);
  assert.match(body.messages[1].content,/そのランクを選んだ決め手/);
  assert.doesNotMatch(body.messages[1].content,/100文字|配列2件/);
  return Response.json({choices:[{message:{content:JSON.stringify({services:[{service_id:"a",evaluation_grade:"A",confidence_level:3,confidence_reasons:["AI判断"],assessment:"風と波は基準未満です。",positive_factors:[],negative_factors:[],port_prediction:"元町",port_confidence_level:1,port_reasons:[]}]})}}]});
 });
 assert.equal(result[0]!.aiStatus,"generated");
 assert.equal(result[0]!.ai!.summary,result[0]!.ai!.assessment);
 assert.deepEqual(result[0]!.ai!.official_criteria_status,[]);
 assert.equal(result[0]!.ai!.confidence_level,3);
 assert.deepEqual(result[0]!.ai!.confidence_reasons,["AI判断"]);
});
