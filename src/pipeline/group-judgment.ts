import { ROUTE_POINTS } from "../config/forecast-points.js";
import { OSHIMA_POINTS, TERMINAL_POINTS } from "../forecast/judgment-context.js";
import type { MultiModelSources } from "../forecast/multi-model.js";
import type { HourlyPoint, ServiceInput } from "../types.js";
import type { ForecastGroup } from "./forecast-groups.js";
import { buildJudgmentBasis } from "./judgment-policy.js";
import { forecastSampleWindow } from "../forecast/sample-window.js";

type Interval = [number,number];
type Event = [number,number,string,number|null]; // value, minute from JST date, location, paired direction
interface Region {
  area:string; points:string[]; periods:Interval[];
  wind:Array<{model:string;low:Event|null;high:Event|null;missing:boolean}>;
  sea:Array<{model:string;wave:[Event|null,Event|null];swell:[Event|null,Event|null];missing:boolean}>;
  rain:Array<{model:string;wetHours:number[];missing:boolean}>;
}
interface Comparison {
  criterion:string;unit:string;threshold:number;model:string;range:[number|null,number|null];
  states:string[];periods:Interval[];statePeriods:Array<[string,Interval[]]>;peak:Event|null;
}
export interface GroupJudgmentMaterial {
  version:"group-weather-v1";date:string;shipType:string;count:number;
  regions:Region[];official:Comparison[];experience:Comparison[];
  policy:{flags:number;largeMorningPrior:"none"|"some"|"all"};
  ml:Array<[string,number|null,number|null,string[]]>;
}

const HOUR=3_600_000;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
/** Union only overlapping intervals. A gap without a scheduled operation stays a gap. */
export function mergeIntervals(intervals:Interval[]):Interval[]{
 const merged:Interval[]=[];
 for(const [start,end] of intervals.map(row=>[...row] as Interval).sort((a,b)=>a[0]-b[0])){
  const last=merged.at(-1);
  if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);
 }
 return merged;
}

export function buildGroupJudgmentMaterial(group:ForecastGroup, members:Array<{serviceId:string;input:unknown}>, sources:MultiModelSources):GroupJudgmentMaterial {
 const base=Date.parse(`${group.date}T00:00:00+09:00`);
 const minute=(time:number)=>(time-base)/60_000;
 const periods=(rows:Interval[])=>mergeIntervals(rows).map(([a,b])=>[minute(a),minute(b)] as Interval);
 const regions=new Map<string,{points:string[];periods:Interval[]}>();
 const add=(area:string,points:readonly string[],interval:Interval)=>{
  const row=regions.get(area)??{points:[...points],periods:[]};row.periods.push(interval);regions.set(area,row);
 };
 const select=(rows:HourlyPoint[],points:readonly string[],intervals:Interval[])=>rows.filter(row=>points.includes(row.locationId)&&intervals.some(period=>{const [a,b]=forecastSampleWindow(...period);return row.timestampMs>=a&&row.timestampMs<=b;}));
 const extrema=(rows:HourlyPoint[],variable:string,direction:string):[Event|null,Event|null]=>{
  const values=rows.filter(row=>finite(row.values[variable])).sort((a,b)=>a.timestampMs-b.timestampMs||a.locationId.localeCompare(b.locationId));
  if(!values.length)return[null,null];
  let low=values[0]!,high=values[0]!;
  for(const row of values){if(row.values[variable]!<low.values[variable]!)low=row;if(row.values[variable]!>high.values[variable]!)high=row;}
  const event=(row:HourlyPoint):Event=>[row.values[variable]!,minute(row.timestampMs),row.locationId,finite(row.values[direction])?row.values[direction]!:null];
  return[event(low),event(high)];
 };
 const snapshots=members.map(member=>member.input as ReturnType<typeof import("../forecast/judgment-context.js").buildJudgmentContext>);
 const hourlyIndexes=new Map<HourlyPoint[],Map<string,HourlyPoint>>();
 for(const source of [...sources.weather,...sources.marine])hourlyIndexes.set(source.rows,new Map(source.rows.map(row=>[`${row.locationId}:${row.timestampMs}`,row])));
 for(const {service} of snapshots){
  const start=Date.parse(service.scheduledDepartureJst),end=Date.parse(service.scheduledArrivalJst);
  const to=service.direction==="to_oshima";
  add(`航路:${service.counterpartTerminal}`,ROUTE_POINTS[service.counterpartTerminal]??[],[start,end]);
  add(`港:${service.counterpartTerminal}`,TERMINAL_POINTS[service.counterpartTerminal]??[],to?[start-HOUR,start+HOUR]:[end-HOUR,end+HOUR]);
  add("大島側",OSHIMA_POINTS,to?[end-HOUR,end+HOUR]:[start-HOUR,start+HOUR]);
 }
 const coverageMissing=(rows:HourlyPoint[],points:readonly string[],intervals:Interval[],variables:string[])=>{
  for(const point of points)for(const [start,end] of mergeIntervals(intervals)){
   const [sampleStart,sampleEnd]=forecastSampleWindow(start,end);
   // Forecasts are hourly. Never infer zero or complete coverage from a peak alone.
   for(let hour=Math.ceil(sampleStart/HOUR)*HOUR;hour<=sampleEnd;hour+=HOUR)
    if(!variables.every(variable=>finite(hourlyIndexes.get(rows)?.get(`${point}:${hour}`)?.values[variable])))return true;
  }
  return false;
 };
 const groupedRegions:Region[]=[...regions].map(([area,row])=>({area,points:row.points,periods:periods(row.periods),
  wind:sources.weather.map(source=>{
   const [low,high]=extrema(select(source.rows,row.points,row.periods),"wind_speed_10m","wind_direction_10m");
   return{model:source.model.label,low,high,missing:coverageMissing(source.rows,row.points,row.periods,["wind_speed_10m","wind_direction_10m"])};
  }),
  sea:sources.marine.map(source=>({model:source.model.label,
   wave:extrema(select(source.rows,row.points,row.periods),"wave_height","wave_direction"),
   swell:extrema(select(source.rows,row.points,row.periods),"swell_wave_height","swell_wave_direction"),
   missing:coverageMissing(source.rows,row.points,row.periods,["wave_height","wave_direction","swell_wave_height","swell_wave_direction"])})),
  rain:area!=="大島側"?[]:sources.weather.map(source=>({model:source.model.label,
   wetHours:[...new Set(select(source.rows,row.points,row.periods).filter(row=>finite(row.values.precipitation)&&row.values.precipitation!>0).map(row=>minute(row.timestampMs)))].sort((a,b)=>a-b),
   missing:coverageMissing(source.rows,row.points,row.periods,["precipitation"])}))
 }));
 const summarizeComparisons=(experience:boolean):Comparison[]=>{
  const grouped=new Map<string,{rows:Array<{criterion:string;model:string;unit:string;threshold:number;forecast:number|null;status:string}>;periods:Interval[];statePeriods:Map<string,Interval[]>;scopes:Array<{points:readonly string[];period:Interval}>}>();
  for(const snapshot of snapshots){
   const service=snapshot.service,start=Date.parse(service.scheduledDepartureJst),end=Date.parse(service.scheduledArrivalJst);
   const rows=experience?snapshot.experienceCriteria.map(row=>({...row,unit:row.criterion.endsWith("wind")?"m/s":"m",status:row.reached?"reached":"below"})):snapshot.officialCriteria;
   for(const row of rows){
    const key=JSON.stringify([row.criterion,row.model,row.threshold]);
    const record=grouped.get(key)??{rows:[],periods:[],statePeriods:new Map<string,Interval[]>(),scopes:[]};record.rows.push(row);
    const entry=row.criterion.includes("oshima_entry"),departure=row.criterion.includes("departure_port");
    const points=experience?(ROUTE_POINTS[service.counterpartTerminal]??[]).filter(id=>id.startsWith("sagami_")):entry?OSHIMA_POINTS:departure?(TERMINAL_POINTS[service.counterpartTerminal]??[]):(ROUTE_POINTS[service.counterpartTerminal]??[]);
    const period:Interval=entry?[end-HOUR,end+HOUR]:departure?[start-HOUR,start+HOUR]:[start,end];
    record.periods.push(period);record.scopes.push({points,period});record.statePeriods.set(row.status,[...(record.statePeriods.get(row.status)??[]),period]);grouped.set(key,record);
   }
  }
  return [...grouped.values()].map(record=>{
   const first=record.rows[0]!,values=record.rows.map(row=>row.forecast).filter(finite);
   const weather=first.unit==="m/s",source=(weather?sources.weather:sources.marine).find(source=>source.model.label===first.model);
   const max=values.length?Math.max(...values):null;
   const variable=weather?"wind_speed_10m":"wave_height",direction=weather?"wind_direction_10m":"wave_direction";
   const candidates=source?record.scopes.flatMap(scope=>select(source.rows,scope.points,[scope.period])).filter(row=>row.values[variable]===max):[];
   return{criterion:first.criterion,model:first.model,unit:first.unit,threshold:first.threshold,range:[values.length?Math.min(...values):null,max],
    states:[...new Set(record.rows.map(row=>row.status))].sort(),periods:periods(record.periods),
    statePeriods:record.statePeriods.size>1?[...record.statePeriods].map(([status,rows])=>[status,periods(rows)]):[],peak:extrema(candidates,variable,direction)[1]};
  });
 };
 const bases=snapshots.map(buildJudgmentBasis).filter((basis):basis is NonNullable<typeof basis>=>basis!==null);
 const flags=Number(bases.length===members.length&&bases.every(b=>b.assessable))+2*Number(bases.length===members.length&&bases.every(b=>b.complete))+
  4*Number(bases.some(b=>b.disagreement))+8*Number(bases.some(b=>b.nearBoundary))+16*Number(bases.some(b=>b.concerns))+32*Number(bases.length===members.length&&bases.every(b=>b.strongEvidence));
 const ml=[...new Set(snapshots.map(row=>row.service.counterpartTerminal))].map(route=>{
  const rows=snapshots.filter(row=>row.service.counterpartTerminal===route).map(row=>(row.ml.result as any)?.comparison).filter(Boolean);
  const values=rows.map(row=>row.mean).filter(finite);
  return [route,values.length?Math.min(...values):null,values.length?Math.max(...values):null,[...new Set<string>(rows.map(row=>String(row.agreement)))]] as [string,number|null,number|null,string[]];
 });
 return{version:"group-weather-v1",date:group.date,shipType:group.shipType,count:members.length,regions:groupedRegions,
  official:summarizeComparisons(false),experience:summarizeComparisons(true),ml,
  policy:{flags,largeMorningPrior:bases.every(b=>b.portSignals.largeMorningPrior)?"all":bases.some(b=>b.portSignals.largeMorningPrior)?"some":"none"}};
}
