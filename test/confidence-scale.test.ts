import test from "node:test";
import assert from "node:assert/strict";
import { confidenceLevel, CONFIDENCE_SCALE } from "../src/pipeline/confidence-scale.js";
import { handleRequest } from "../src/worker/index.js";

test("legacy five-level values and new three-level values keep their distinct meanings",()=>{
 assert.deepEqual([1,2,3,4,5].map(value=>confidenceLevel(value)),[1,1,2,3,3]);
 const current={confidence_scale:CONFIDENCE_SCALE};
 assert.deepEqual([1,2,3,4,5].map(value=>confidenceLevel(value,current)),[1,2,3,null,null]);
 assert.equal(confidenceLevel(2,{prompt_version:'assessment-v29-abcd-confidence-three-level'}),2);
 assert.equal(confidenceLevel(null,current),null);
 assert.equal(confidenceLevel(1.5,current),null);
});

test("served confidence panel joins level and escaped reasons and handles historical values",async()=>{
 const app=await (await handleRequest(new Request('https://local/app.js'))).text();
 const helpers=app.slice(app.indexOf('function confidenceRank('),app.indexOf('function updateTimeLabel('));
 const panel=new Function('esc',helpers+';return confidencePanel;')((s:unknown)=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'));
 const html=panel({confidence_level:2,confidence_scale:CONFIDENCE_SCALE},['モデル間で波高に差があります。<script>']);
 assert.match(html,/確信度：中/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.match(panel({confidence_level:2},[]),/確信度：低/);
 assert.match(panel({confidence_level:4},[]),/確信度：高/);
 assert.match(panel({confidence_level:null},[]),/確信度：未評価/);
 assert.doesNotMatch(app,/scale\('確信度',\['1','2','3','4','5'\]/);
});
