import test from "node:test"; import assert from "node:assert/strict";
import { WEATHER_MODELS, MARINE_MODELS } from "../src/forecast/multi-model.js";
import { fetchMultiModelSources, runMultiModelPredictions, hasCompleteMlCoverage } from '../src/forecast/multi-model.js';
import { FORECAST_POINTS } from '../src/config/forecast-points.js';
import { WEATHER_VARIABLES, MARINE_VARIABLES, fetchBatch } from '../src/forecast/open-meteo.js';
import model from '../models/cloudflare_portable_model.v2.json' with {type:'json'};
import type { EnsembleModelBundle } from '../src/ml/inference.js';
import type { ServiceInput } from '../src/types.js';
test("phase 2 uses the audited forecast model set",()=>{assert.deepEqual(WEATHER_MODELS.map(x=>x.id),["jma_msm","ecmwf_ifs025","gfs_seamless"]);assert.deepEqual(MARINE_MODELS.map(x=>x.id),["ecmwf_wam","ncep_gfswave025"])});

test('partial source values remain available to AI but incomplete ML pairs are excluded',async()=>{
 const times=Array.from({length:24},(_,hour)=>`2026-09-29T${String(hour).padStart(2,'0')}:00`);
 const mock:typeof fetch=async(url)=>{
  const request=new URL(String(url)),id=request.searchParams.get('models'),variables=request.searchParams.get('hourly')!.split(',');
  return Response.json(FORECAST_POINTS.map(()=>({hourly:Object.fromEntries([['time',times],...variables.map(variable=>[variable,times.map(()=>
   id==='jma_msm'&&variable==='wind_gusts_10m'||id==='ecmwf_wam'&&/^(wind_wave|swell_wave)/.test(variable)?null:
    variable.includes('direction')?180:variable.includes('pressure')?1012:variable.includes('period')?7:variable.includes('wind')?5:1)])])})));
 };
 const sources=await fetchMultiModelSources(mock);
 assert.equal(sources.weather.length,3);assert.equal(sources.marine.length,2);
 assert.equal(sources.weather[0]!.rows[0]!.values.wind_speed_10m,5);
 assert.equal(sources.weather[0]!.rows[0]!.values.wind_gusts_10m,undefined);
 assert.equal(sources.marine[0]!.rows[0]!.values.wave_height,1);
 assert.equal(sources.marine[0]!.rows[0]!.values.swell_wave_height,undefined);
 const service:ServiceInput={serviceId:'a',voyageNumber:'1100',shipType:'jet',direction:'to_oshima',counterpartTerminal:'熱海',scheduledDepartureJst:'2026-09-29T09:10:00+09:00',scheduledArrivalJst:'2026-09-29T09:55:00+09:00'};
 const ml=await runMultiModelPredictions(service,model as EnsembleModelBundle,mock,sources);
 assert.equal(ml.predictions.length,2);assert.equal(ml.mlFailures.length,4);
 assert.ok(ml.predictions.every(row=>row.weatherModel!=='JMA MSM'&&row.marineModel==='GFS Wave'));
 const missingHour=sources.weather[1]!.rows.filter(row=>row.timestampMs!==Date.parse('2026-09-29T05:00:00+09:00'));
 assert.equal(hasCompleteMlCoverage(service,missingHour,sources.marine[1]!.rows),false);
 await assert.rejects(()=>fetchBatch(WEATHER_MODELS[0].url,WEATHER_VARIABLES,mock,'jma_msm'),/wind_gusts/);
 await assert.rejects(()=>fetchBatch('https://marine-api.open-meteo.com/v1/marine',MARINE_VARIABLES,mock,'ecmwf_wam'),/wind_wave/);
});
