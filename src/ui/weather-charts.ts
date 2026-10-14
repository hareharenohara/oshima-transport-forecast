import { TOKAI_KISEN_OFFICIAL } from '../knowledge/tokai-kisen-official.js';

const routeLimits = Object.fromEntries(['jet', 'large'].map(type => {
  const route = TOKAI_KISEN_OFFICIAL[type as 'jet' | 'large'].route;
  return [type, {
    wind_speed_10m: { change: route.navigationChange.windMs, stop: route.departureStop.windMs },
    wave_height: { change: route.navigationChange.waveM, stop: route.departureStop.waveM }
  }];
}));

export const WEATHER_CHARTS_CSS = `
.weather-panel{--weather-model-1:var(--sea);--weather-model-2:#7657a5;--weather-model-3:#3873b6;--weather-model-4:var(--muted);--weather-change:#a4630b;--weather-stop:#b94739;position:relative}
:root[data-theme="dark"] .weather-panel{--weather-model-2:#b399dd;--weather-model-3:#89b5ff;--weather-change:#eeb76b;--weather-stop:#f09889}
.weather-chart-holder{margin-top:10px;min-width:0;position:relative}
.weather-voyage-button{position:absolute;top:0;transform:translateX(-50%);width:44px;height:36px;padding:8px 12px;border:0;background:transparent;color:var(--sea);display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer}
.weather-voyage-button svg{width:20px;height:20px;flex-shrink:0}
.weather-voyage-button:focus-visible{outline:2px solid var(--sea);outline-offset:1px}
.weather-voyage-button:hover{background:color-mix(in srgb,var(--sea) 8%,transparent)}
.weather-voyage-time{position:absolute;top:36px;left:0;right:0;z-index:2;margin:0;padding:8px 10px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:11px;color:var(--ink);text-align:center;box-shadow:var(--shadow)}
.weather-chart{width:100%;height:auto;display:block;overflow:visible;touch-action:pan-y}
.weather-chart .weather-axis{fill:var(--muted);font:11px system-ui,sans-serif}
.weather-chart .weather-date{font-size:10px}
.weather-chart .weather-model-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.weather-chart .weather-limit{stroke-width:1.5;stroke-dasharray:5 4;fill:none}
.weather-chart .weather-limit-change{stroke:var(--weather-change)}
.weather-chart .weather-limit-stop{stroke:var(--weather-stop)}
.weather-chart .weather-limit-label{fill:var(--ink);font:11px system-ui,sans-serif}
.weather-chart .weather-hover-line{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.weather-legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px}
.weather-legend span{font-size:10px;color:var(--muted)}
.weather-legend i{display:inline-block;width:12px;height:3px;margin-right:4px;vertical-align:middle;border-radius:3px}
.weather-note{font-size:10px!important;color:var(--muted)}
.weather-tooltip{position:absolute;z-index:1;left:18px;right:18px;bottom:45px;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);box-shadow:var(--shadow);font-size:11px;line-height:1.6;pointer-events:none}
`;

export const WEATHER_CHARTS_JS = `
const wcLimits=${JSON.stringify(routeLimits)};
const wcSafe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const wcLabels={wind_speed_10m:'風速',wind_gusts_10m:'最大瞬間風速',wave_height:'波高',wave_period:'波周期',swell_wave_height:'うねり高'};
const wcHour=3600000;
const wcFullTime=value=>new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const wcClock=value=>new Date(value).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false});
const wcDate=value=>new Date(value).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'});
function weatherThresholds(series,service){
  const first=series[0];
  if(!first||first.aggregation!=='route_max')return null;
  return wcLimits[service?.ship_type]?.[first.variable]||null;
}
function weatherVoyage(service){
  const departure=Date.parse(service?.scheduled_departure),arrival=Date.parse(service?.scheduled_arrival);
  return Number.isFinite(departure)&&Number.isFinite(arrival)&&arrival>departure?{departure,arrival}:null;
}
function weatherTimeTicks(start,end,width){
  const maxLabels=Math.max(2,Math.floor(width/46)+1),duration=(end-start)/wcHour;
  const step=[1,2,3,4,6,12,24,48,72,168].find(hours=>duration/hours<=maxLabels-1)||Math.ceil(duration/(maxLabels-1));
  const labels=[start];
  for(let time=start+step*wcHour;time<end;time+=step*wcHour)labels.push(time);
  if(end>start){if(labels.length>1&&(end-labels.at(-1))/(end-start)*width<40)labels.pop();labels.push(end);}
  const minor=[];
  const minorStep=Math.max(1,Math.ceil(duration/48));
  for(let time=Math.ceil(start/wcHour)*wcHour;time<=end;time+=minorStep*wcHour)minor.push(time);
  return {labels,minor,step};
}
function weatherChart(series,service,width=560){
  const clean=series.map(item=>({...item,values:item.values.filter(p=>Number.isFinite(p.value)&&Number.isFinite(Date.parse(p.time)))}));
  const all=clean.flatMap(item=>item.values.map(p=>p.value)),times=[...new Set(clean.flatMap(item=>item.values.map(p=>Date.parse(p.time))))].sort((a,b)=>a-b);
  if(!all.length)return '';
  width=Math.max(200,width);
  const limit=weatherThresholds(clean,service),voyage=weatherVoyage(service),height=254,left=30,right=12,top=36,bottom=52,w=width-left-right,h=height-top-bottom;
  const start=Math.min(times[0],voyage?.departure??times[0]),end=Math.max(times.at(-1),voyage?.arrival??times.at(-1)),range=Math.max(end-start,wcHour);
  const upper=Math.max(1,...all,limit?.stop||0)*1.12;
  const rawStep=upper/4,power=10**Math.floor(Math.log10(rawStep)),step=[1,2,2.5,5,10].map(v=>v*power).find(v=>v>=rawStep),max=Math.ceil(upper/step)*step;
  const x=time=>left+(time-start)/range*w,y=value=>top+(max-value)/max*h;
  const grid=Array.from({length:Math.round(max/step)+1},(_,i)=>i*step).map(value=>'<line class="chart-grid" x1="'+left+'" x2="'+(left+w)+'" y1="'+y(value)+'" y2="'+y(value)+'"/><text class="weather-axis" x="'+(left-6)+'" y="'+(y(value)+4)+'" text-anchor="end">'+Number(value.toFixed(2))+'</text>').join('');
  const ticks=weatherTimeTicks(start,end,w);
  const minor=ticks.minor.map(time=>'<line class="chart-grid" x1="'+x(time)+'" x2="'+x(time)+'" y1="'+(top+h)+'" y2="'+(top+h+4)+'"/>').join('');
  let previousDate=null;
  const tickLabels=ticks.labels.map((time,index)=>{
    const date=wcDate(time),showDate=index===0||date!==previousDate;previousDate=date;
    const anchor=index===0?'start':index===ticks.labels.length-1?'end':'middle';
    return '<line class="chart-grid" x1="'+x(time)+'" x2="'+x(time)+'" y1="'+top+'" y2="'+(top+h)+'"/><text class="weather-axis" data-time="'+new Date(time).toISOString()+'" x="'+x(time)+'" y="'+(height-31)+'" text-anchor="'+anchor+'">'+wcClock(time)+'</text>'+(showDate?'<text class="weather-axis weather-date" x="'+x(time)+'" y="'+(height-14)+'" text-anchor="'+anchor+'">'+date+'</text>':'');
  }).join('');
  const paths=clean.map((item,index)=>'<polyline class="weather-model-line" style="stroke:var(--weather-model-'+(index%4+1)+')" points="'+item.values.map(p=>x(Date.parse(p.time)).toFixed(2)+','+y(p.value).toFixed(2)).join(' ')+'"/>').join('');
  let baselines='';
  if(limit){
    const stopY=y(limit.stop),changeY=y(limit.change);
    baselines='<line class="weather-limit weather-limit-change" data-threshold="'+limit.change+'" x1="'+left+'" x2="'+(left+w)+'" y1="'+changeY+'" y2="'+changeY+'"/><line class="weather-limit weather-limit-stop" data-threshold="'+limit.stop+'" x1="'+left+'" x2="'+(left+w)+'" y1="'+stopY+'" y2="'+stopY+'"/>';
  }
  const band=voyage?'<rect class="weather-voyage-band" data-departure="'+voyage.departure+'" data-arrival="'+voyage.arrival+'" x="'+x(voyage.departure)+'" y="'+top+'" width="'+(x(voyage.arrival)-x(voyage.departure))+'" height="'+h+'" fill="var(--sea)" opacity=".10"/>'+[voyage.departure,voyage.arrival].map(time=>'<line x1="'+x(time)+'" x2="'+x(time)+'" y1="'+top+'" y2="'+(top+h)+'" stroke="var(--sea)" opacity=".4"/>').join(''):'';
  const voyageLabel=voyage?'出航 '+wcFullTime(voyage.departure)+' → 着港 '+wcFullTime(voyage.arrival):'';
  const boat=voyage?'<button type="button" class="weather-voyage-button" style="left:'+((x(voyage.departure)+x(voyage.arrival))/2)+'px" aria-label="'+wcSafe(voyageLabel)+'。時刻を表示" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v3M6 11V6h12v5M3 12l9-3 9 3-3 7M3 12l3 7M12 9v10M2 21c2 0 3-2 5-2s3 2 5 2 3-2 5-2 3 2 5 2"/></svg></button><p class="weather-voyage-time" hidden>'+wcSafe(voyageLabel)+'</p>':'';
  return '<svg class="weather-chart" tabindex="0" viewBox="0 0 '+width+' '+height+'" data-start="'+start+'" data-end="'+end+'" data-left="'+left+'" data-plot-width="'+w+'" role="img" aria-label="'+wcSafe(wcLabels[clean[0].variable])+'のモデル別予報。'+wcSafe(wcFullTime(start))+'から'+wcSafe(wcFullTime(end))+'まで。横軸は日本時間。'+(limit?'変更基準 '+limit.change+'、中止基準 '+limit.stop+' '+wcSafe(clean[0].unit)+'。':'')+'タップ、または左右キーで時刻ごとの予報値を確認できます。">'+band+grid+minor+tickLabels+paths+baselines+'<line class="weather-hover-line" hidden y1="'+top+'" y2="'+(top+h)+'"/></svg>'+boat;
}
function weatherPanels(payload,service){
  return ['wind_speed_10m','wind_gusts_10m','wave_height','wave_period','swell_wave_height'].map(variable=>{
    const series=payload.points.filter(item=>item.variable===variable);if(!series.length)return '';
    return '<section class="panel weather-panel" data-weather-variable="'+variable+'"><h3>'+wcLabels[variable]+'（'+wcSafe(series[0].unit)+'）</h3><div class="weather-chart-holder"></div><p class="weather-note">航路上の'+(series[0].aggregation==='route_max'?'最大値':'平均値')+' · 日本時間</p><div class="weather-tooltip" hidden aria-live="polite"></div></section>';
  }).join('');
}
function bindWeatherChart(panel,series,service){
  const svg=panel.querySelector('.weather-chart'),tooltip=panel.querySelector('.weather-tooltip'),guide=svg.querySelector('.weather-hover-line');
  const boat=panel.querySelector('.weather-voyage-button'),voyageTime=panel.querySelector('.weather-voyage-time'),limit=weatherThresholds(series,service);
  if(boat){boat.addEventListener('click',()=>{const expanded=boat.getAttribute('aria-expanded')!=='true';boat.setAttribute('aria-expanded',String(expanded));voyageTime.hidden=!expanded;tooltip.hidden=true;guide.setAttribute('hidden','');});boat.addEventListener('keydown',event=>{if(event.key==='Escape'){boat.setAttribute('aria-expanded','false');voyageTime.hidden=true;}});}
  const times=[...new Set(series.flatMap(item=>item.values.map(p=>Date.parse(p.time))))].sort((a,b)=>a-b);
  let selected=0,pinned=false;
  function show(index){
    selected=Math.max(0,Math.min(times.length-1,index));const time=times[selected];
    const x=Number(svg.dataset.left)+(time-Number(svg.dataset.start))/Math.max(Number(svg.dataset.end)-Number(svg.dataset.start),wcHour)*Number(svg.dataset.plotWidth);
    guide.setAttribute('x1',x);guide.setAttribute('x2',x);guide.hidden=false;guide.removeAttribute('hidden');
    if(voyageTime){voyageTime.hidden=true;boat.setAttribute('aria-expanded','false');}
    tooltip.innerHTML='<strong>'+wcSafe(wcFullTime(time))+'</strong><br>'+series.map((item,index)=>{const point=item.values.find(p=>Date.parse(p.time)===time);return '<span style="color:var(--weather-model-'+(index%4+1)+')">●</span> '+wcSafe(item.model)+'：'+(point?Number(point.value.toFixed(2))+' '+wcSafe(item.unit):'データなし');}).join('<br>')+(limit?'<br>変更 '+limit.change+' / 中止 '+limit.stop+' '+wcSafe(series[0].unit):'');
    tooltip.hidden=false;
  }
  function atPointer(event){const bounds=svg.getBoundingClientRect(),width=svg.viewBox.baseVal.width,position=(event.clientX-bounds.left)/bounds.width*width;const fraction=Math.max(0,Math.min(1,(position-Number(svg.dataset.left))/Number(svg.dataset.plotWidth)));const target=Number(svg.dataset.start)+fraction*(Number(svg.dataset.end)-Number(svg.dataset.start));return times.reduce((best,time,index)=>Math.abs(time-target)<Math.abs(times[best]-target)?index:best,0);}
  svg.addEventListener('pointermove',event=>{if(!pinned&&event.pointerType!=='touch')show(atPointer(event));});
  svg.addEventListener('pointerleave',()=>{if(!pinned){tooltip.hidden=true;guide.setAttribute('hidden','');}});
  svg.addEventListener('click',event=>{pinned=true;show(atPointer(event));});
  svg.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();pinned=true;show(selected+(event.key==='ArrowRight'?1:-1));}else if(event.key==='Escape'){pinned=false;tooltip.hidden=true;guide.setAttribute('hidden','');}});
}
let weatherChartObservers=[];
function mountWeatherCharts(target,payload,service){
  weatherChartObservers.forEach(observer=>observer.disconnect());weatherChartObservers=[];
  target.querySelector('[data-weather-primary]').replaceChildren();target.querySelector('[data-weather-secondary]').replaceChildren();
  const panels=document.createElement('div');panels.innerHTML=weatherPanels(payload,service);
  for(const panel of [...panels.children]){
    const primary=['wind_speed_10m','wave_height'].includes(panel.dataset.weatherVariable);
    target.querySelector(primary?'[data-weather-primary]':'[data-weather-secondary]').append(panel);
  }
  target.querySelector('.detail-weather-more').hidden=!target.querySelector('[data-weather-secondary]').children.length;
  if(!target.querySelector('[data-weather-primary]').children.length)target.querySelector('[data-weather-primary]').innerHTML='<p class="weather-note">風速・波高の予報データは未取得です。</p>';
  for(const panel of target.querySelectorAll('.weather-panel')){
    const holder=panel.querySelector('.weather-chart-holder'),series=payload.points.filter(item=>item.variable===panel.dataset.weatherVariable);
    let previousWidth=0;
    function draw(){const width=holder.clientWidth;if(width===previousWidth||!width)return;previousWidth=width;panel.querySelector('.weather-tooltip').hidden=true;holder.innerHTML=weatherChart(series,service,width);if(holder.querySelector('.weather-chart'))bindWeatherChart(panel,series,service);}
    draw();const observer=new ResizeObserver(draw);observer.observe(holder);weatherChartObservers.push(observer);
  }
}
let weatherRequest=0;
document.addEventListener('service-detail-ready',async event=>{
  const {id,service}=event.detail,request=++weatherRequest;
  const currentTarget=()=>{const detail=document.querySelector('#detail');return request===weatherRequest&&detail?.querySelector('[data-weather-primary]')&&detail.querySelector('[data-watch-service]')?.dataset.watchService===id?detail:null;};
  try{
    const seriesResponse=await fetch('/api/services/'+encodeURIComponent(id)+'/series');
    if(!seriesResponse.ok)throw Error();
    const payload=(await seriesResponse.json()).series,target=currentTarget();
    if(target&&!target.querySelector('.weather-panel'))mountWeatherCharts(target,payload,service);
  }catch{const target=currentTarget();if(target){target.querySelector('[data-weather-primary]').innerHTML='<p class="weather-note">気象グラフを取得できませんでした。公式運航情報をご確認ください。</p>';target.querySelector('.detail-weather-more').hidden=true;}}
});
`;
