import test from "node:test"; import assert from "node:assert/strict";
import { compareModels } from "../src/forecast/model-comparison.js";
import { assessWithFallback, validateAssessment } from "../src/gemini/client.js";
test("compares forecast models",()=>{const x=compareModels([{model:"MSM",value:10},{model:"ECMWF",value:12},{model:"GFS",value:11}],2,5);assert.equal(x.mean,11);assert.equal(x.agreement,"high");assert.ok(x.stddev>0)});
test("validates final assessment",()=>{assert.equal(validateAssessment({operation_probability:40,confidence:50,assessment:"注意",positive_factors:[],negative_factors:["波"],confidence_reasons:[],port_prediction:"岡田",summary:"注意"}).confidence,50)});
test("Gemini failure preserves ML fallback",async()=>{const x=await assessWithFallback({}, {cancellationProbability:.2}, "x", async()=>new Response("bad",{status:500}));assert.equal(x.ai,null);assert.equal(x.aiStatus,"unavailable");assert.deepEqual(x.ml,{cancellationProbability:.2})});
