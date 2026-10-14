import test from "node:test";
import assert from "node:assert/strict";
import { FORECAST_POINTS } from "../src/config/forecast-points.js";
import { buildJudgmentContext } from "../src/forecast/judgment-context.js";
import { WEATHER_MODELS, MARINE_MODELS, type MultiModelSources } from "../src/forecast/multi-model.js";
import { groupForecastServices } from "../src/pipeline/forecast-groups.js";
import { buildGroupJudgmentMaterial, mergeIntervals } from "../src/pipeline/group-judgment.js";
import { packDirectJudgments } from "../src/groq/client.js";
import { buildPortMaterial } from "../src/pipeline/port-material.js";
import type { HourlyPoint, ServiceInput } from "../src/types.js";

const now=new Date("2026-10-07T00:00:00+09:00"),date="2026-10-11",base=Date.parse(`${date}T00:00:00+09:00`);
function service(hour:number,arrival=hour+2,route="東京"):ServiceInput {
 return {serviceId:`test-${hour}-${route}`,voyageNumber:"1",shipType:"jet",direction:"to_oshima",counterpartTerminal:route,
 scheduledDepartureJst:new Date(base+hour*3600000).toISOString(),scheduledArrivalJst:new Date(base+arrival*3600000).toISOString()};
}
function sources():MultiModelSources {
 const rows:HourlyPoint[]=FORECAST_POINTS.flatMap(point=>Array.from({length:30},(_,hour)=>({locationId:point.id,timestampMs:base+hour*3600000,
 values:{wind_speed_10m:0,wind_direction_10m:0,precipitation:0,wave_height:0,wave_direction:0,swell_wave_height:0,swell_wave_direction:0}})));
 return {weather:WEATHER_MODELS.map(model=>({model,rows:structuredClone(rows)})),marine:MARINE_MODELS.map(model=>({model,rows:structuredClone(rows)})),failures:[]};
}
function material(services:ServiceInput[],data:MultiModelSources) {
 const group=groupForecastServices(services,now)[0]!;
 const members=services.map(service=>({serviceId:service.serviceId,input:buildJudgmentContext(service,{comparison:{mean:.2,agreement:"close"}},data,null,now)}));
 return {group,members,aggregate:buildGroupJudgmentMaterial(group,members,data)};
}
function set(rows:HourlyPoint[],hour:number,point:string,values:Record<string,number>) {
 Object.assign(rows.find(row=>row.timestampMs===base+hour*3600000&&row.locationId===point)!.values,values);
}

test('daily port summary preserves port/model differences, excludes idle hours and marks missing coverage',()=>{
 const data=sources(),services=[service(8),service(14)];
 set(data.weather[0]!.rows,10,'oshima_west_motomachi',{wind_speed_10m:9,wind_direction_10m:210,precipitation:.3});
 set(data.weather[0]!.rows,10,'oshima_north_okata',{wind_speed_10m:4,wind_direction_10m:90});
 set(data.weather[0]!.rows,13,'oshima_west_motomachi',{wind_speed_10m:99});
 data.marine[0]!.rows=data.marine[0]!.rows.filter(row=>!(row.locationId==='oshima_north_okata'&&row.timestampMs===base+10*3600000));
 const material=buildPortMaterial(date,services,data);
 assert.deepEqual(material.weather[0]![0],[[9,600,210],.3,0]);
 assert.deepEqual(material.weather[1]![0],[[4,600,90],0,0]);
 assert.equal(material.sea[1]![0]![2],1);
 assert.equal(material.morningLarge,0);
 const items=services.map(service=>({serviceId:service.serviceId,input:{...buildJudgmentContext(service,{},data),portMaterial:material}}));
 const packed=packDirectJudgments(items);
 assert.deepEqual(packed.portMaterial,material);
 assert.equal(JSON.stringify(packed).split('"portMaterial"').length-1,1);
});

test('short operations use enclosing forecasts without inventing a missing endpoint',()=>{
 const data=sources(),short=service(9+10/60,9+55/60,'熱海');
 for(const source of data.weather){set(source.rows,9,'sagami_north',{wind_speed_10m:7,wind_direction_10m:100});set(source.rows,10,'sagami_north',{wind_speed_10m:9,wind_direction_10m:200});}
 const {aggregate,members}=material([short],data);
 assert.equal(members[0]!.input.forecasts.weather[0]!.phases.route.wind_speed_10m,9);
 assert.deepEqual(aggregate.regions.find(row=>row.area==='航路:熱海')!.periods,[[550,595]]);
 assert.deepEqual(aggregate.regions.find(row=>row.area==='航路:熱海')!.wind[0]!.high,[9,600,'sagami_north',200]);
 const missing=sources();for(const source of missing.weather)source.rows=source.rows.filter(row=>row.timestampMs!==base+10*3600000);
 assert.equal(material([short],missing).members[0]!.input.forecasts.weather[0]!.phases.route.wind_speed_10m,null);
});

test("operating interval union preserves gaps, overnight arrivals and input",()=>{
 const input:[number,number][]=[[840,960],[480,600],[550,660],[1380,1560]];
 const copy=structuredClone(input);
 assert.deepEqual(mergeIntervals(input),[[480,660],[840,960],[1380,1560]]);
 assert.deepEqual(input,copy);
 const result=material([service(8),service(14),service(23,26)],sources()).aggregate;
 assert.deepEqual(result.regions.find(row=>row.area==='航路:東京')!.periods,[[480,600],[840,960],[1380,1560]]);
});

test("peak events pair value, time, location and direction and exclude non-operating hours",()=>{
 const data=sources();
 for(const source of data.weather){
  set(source.rows,8,'sagami_north',{wind_speed_10m:19,wind_direction_10m:271});
  set(source.rows,12,'sagami_north',{wind_speed_10m:99,wind_direction_10m:90});
 }
 for(const source of data.marine){
  set(source.rows,9,'sagami_central',{wave_height:4.5,wave_direction:181});
  set(source.rows,15,'oshima_west_motomachi',{swell_wave_height:3,swell_wave_direction:225});
 }
 const result=material([service(8),service(14)],data).aggregate;
 const route=result.regions.find(row=>row.area==='航路:東京')!;
 assert.deepEqual(route.wind[0]!.high,[19,480,'sagami_north',271]);
 assert.deepEqual(route.sea[0]!.wave[1],[4.5,540,'sagami_central',181]);
 assert.deepEqual(route.sea[0]!.swell[1],[3,900,'oshima_west_motomachi',225]);
 const comparison=result.experience.find(row=>row.criterion==='nakamura_sagami_wind')!;
 assert.deepEqual(comparison.range,[0,19]);
 assert.deepEqual(comparison.statePeriods,[['reached',[[480,600]]],['below',[[840,960]]]]);
 assert.deepEqual(comparison.peak,[19,480,'sagami_north',271]);
 assert.equal(result.policy.flags&32,0); // Weak afternoon member still prevents group D.
});

test("Sagami guide stays scoped and criterion witnesses retain point/time coupling",()=>{
 const data=sources();
 for(const source of data.weather){
  set(source.rows,8,'tokyo_port',{wind_speed_10m:20,wind_direction_10m:100});
  set(source.rows,14,'atami_offshore',{wind_speed_10m:20,wind_direction_10m:200});
  set(source.rows,8,'atami_offshore',{wind_speed_10m:20,wind_direction_10m:300}); // Not Tokyo route.
  set(source.rows,14,'tokyo_port',{wind_speed_10m:30,wind_direction_10m:350}); // Not Atami route.
 }
 const result=material([service(8),service(14,16,'熱海')],data).aggregate;
 assert.deepEqual(result.official.find(row=>row.criterion==='jet_route_wind')!.peak,[20,480,'tokyo_port',100]);
 assert.ok(result.experience.filter(row=>row.criterion==='nakamura_sagami_wind').every(row=>row.range[1]===0));
});

test("zero, missing hourly coverage, rain times and unavailable model remain distinct",()=>{
 const data=sources();
 delete data.weather[0]!.rows.find(row=>row.locationId==='sagami_north'&&row.timestampMs===base+9*3600000)!.values.wind_direction_10m;
 set(data.weather[0]!.rows,10,'oshima_north_okata',{precipitation:1});
 data.weather.pop();
 const result=material([service(8)],data).aggregate;
 const route=result.regions.find(row=>row.area==='航路:東京')!;
 assert.equal(route.wind[0]!.high![0],0);
 assert.equal(route.wind[0]!.missing,true);
 assert.equal(route.wind[1]!.missing,false);
 assert.deepEqual(result.regions.find(row=>row.area==='大島側')!.rain[0]!.wetHours,[600]);
 assert.equal(result.policy.flags&2,0);
 assert.equal("confidenceCeiling" in result.policy,false);
});

test("group transport does not grow per member when operating conditions are identical",()=>{
 const data=sources(),one=service(8);
 const pack=(services:ServiceInput[])=>{
  const {group,members,aggregate}=material(services,data);
  return packDirectJudgments([{serviceId:group.id,input:{scope:'group',label:group.label,members,aggregateJudgment:aggregate}}]);
 };
 const single=pack([one]),many=pack(Array.from({length:20},(_,i)=>({...one,serviceId:`member-${i}`})));
 const root=many.services[0]!.input as any;
 assert.equal(root.coveredServices,20);
 assert.equal('members' in root,false);
 assert.ok(!JSON.stringify(many).includes('member-'));
 assert.deepEqual(single.definitions,many.definitions);
 assert.deepEqual((single.services[0]!.input as any).mlReference,root.mlReference);
});
