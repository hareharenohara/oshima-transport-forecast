import { BELL_MARKUP } from './notification-bell.js';

export const DETAIL_LAYOUT_CSS = `
.detail-head .meta{padding-right:40px;line-height:1.7}
.detail-official{margin:0 0 14px;background:var(--card);border:1px solid var(--line)}
.detail-official .official-main{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.detail-official .official-main strong{font-size:17px}
.detail-official .official-port{font-weight:600}
.detail-official .official-link{display:block;margin-top:10px;font-size:12px}
.detail-official .official-note{color:var(--ink);font-size:12px!important}
.detail-forecast-meta{color:var(--muted);font-size:11px;margin:0 2px 8px;text-align:right}
.detail-fold{background:var(--card);border-radius:16px;margin-top:13px;padding:0 16px}
.detail-fold>summary{padding:16px 0;cursor:pointer;font-size:13px;font-weight:500;color:var(--ink)}
.detail-fold>.fold-body{padding-bottom:16px}
.detail-fold .panel{padding:12px 0;margin-top:0;border-radius:0;background:transparent}
.detail-fold .panel:last-child{padding-bottom:0}
.detail-fold .panel.official{border:0;background:transparent}
.detail-fold .panel h3{font-size:12px}
.detail-fold .history-panel{padding:0}
.detail-weather-more{padding:0;background:transparent}
.detail-weather-more>summary{padding:16px;background:var(--card);border-radius:16px}
.detail-weather-more[open]>summary{margin-bottom:0}
.detail-weather-more .fold-body{padding-bottom:0}
.detail-change p{font-size:12px}
.detail-predicted-port{font-size:12px;color:var(--muted);margin-top:8px!important}
.about-forecast{max-width:540px;margin:0 auto;text-align:left;font-size:11px}
.about-forecast summary{text-align:center;cursor:pointer;padding:8px;color:var(--muted)}
.about-forecast p{padding:0 12px;color:var(--muted);line-height:1.7}
.group-official-row{padding:10px 0;border-bottom:1px solid var(--line)}
.group-official-row:last-of-type{border-bottom:0}
.group-official-row .group-official-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}
.group-official-row .group-official-note{font-size:11px;color:var(--muted);margin-top:4px}
`;

export const DETAIL_LAYOUT_JS = `
function foldDetail(label,content,className=''){
  return '<details class="detail-fold '+className+'"><summary>'+esc(label)+'</summary><div class="fold-body">'+content+'</div></details>';
}
function showOfficialForService(s,now=new Date()){
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
  const announced=!!(s.official_status||s.official_port||s.official_note);
  return s.service_date===today||(s.service_date>today&&announced);
}
function officialDetail(s){
  if(!showOfficialForService(s))return '';
  const port=s.official_port,hasStatus=!!s.official_status,updated=s.official_source_updated_at;
  return '<section class="panel official detail-official" data-official-service="'+esc(s.service_id)+'"><h3>公式運航情報</h3><div class="official-main"><strong>'+esc(s.official_status||'未発表・未取得')+'</strong>'+(port?'<span class="official-port">'+esc(port.endsWith('港')?port:port+'港')+'</span>':'')+'</div>'+(s.official_note?'<p class="official-note">'+esc(s.official_note)+'</p>':'')+(!hasStatus?'<p class="official-note">公式サイトで最新の運航状況をご確認ください。</p>':'')+(updated&&Number.isFinite(Date.parse(updated))?'<p class="official-time">公式更新 '+esc(updateTimeLabel(new Date(updated)))+'</p>':'')+'<a class="official-link" href="https://www.tokaikisen.co.jp/schedule/" target="_blank" rel="noreferrer">公式サイトを確認</a></section>';
}
function changedDetail(s){
  const change=s.change;if(!change)return '';
  const changes=[];
  if(change.evaluation_changed)changes.push('AI評価が変わりました');
  if(change.port_changed)changes.push('港の予測が変わりました');
  if(Number.isFinite(change.confidence_level_change)&&change.confidence_level_change!==0)changes.push('確信度が'+(change.confidence_level_change>0?'上がりました':'下がりました'));
  return changes.length?'<section class="panel detail-change"><h3>前回からの変化</h3><p>'+changes.map(esc).join(' · ')+'</p></section>':'';
}
function groupOfficialDetail(day,group){
  const members=day.services.filter(s=>group.member_ids.includes(s.service_id)&&showOfficialForService(s));
  if(!members.length)return '';
  return '<section class="panel official detail-official"><h3>対象便の公式運航情報</h3>'+members.map(s=>'<div class="group-official-row"><div class="group-official-head"><span>'+esc(time(s.scheduled_departure)+' '+s.origin+' → '+s.destination)+'</span>'+officialBadge(s)+(s.official_status?'':'<span>未発表・未取得</span>')+(s.official_port?'<span>'+esc(s.official_port)+'</span>':'')+'</div>'+(s.official_note?'<p class="group-official-note">'+esc(s.official_note)+'</p>':'')+'</div>').join('')+'<a class="official-link" href="https://www.tokaikisen.co.jp/schedule/" target="_blank" rel="noreferrer">公式サイトを確認</a></section>';
}
function modelDetail(models){
  return models.length?'<section class="panel"><h3>モデル別 欠航リスク</h3><p class="meta">過去実績と気象予報による統計モデルの参考値です。AI評価とは別の指標です。</p>'+models.map(m=>'<div class="model-row"><span>'+esc(m.weatherModel)+' + '+esc(m.marineModel)+'</span><b>'+Math.round(m.cancellationProbability*100)+'%</b><div class="model-track"><i style="width:'+Math.round(m.cancellationProbability*100)+'%"></i></div></div>').join('')+'</section>':'';
}
function detailLayout(s,history,group){
  const latest=history.find(row=>row.created_at===s.prediction_created_at),view=group||s,evidence=group?.assessment||latest;
  const stale=group?group.stale:s.latest_ai_status==='unavailable'&&s.ai_status==='generated';
  const published=group?.published_at||s.prediction_published_at;
  const reason=confidencePanel(group?.assessment||s,evidence?.confidence_reasons)+factors(evidence?.positive_factors,'プラス要因','')+factors(evidence?.negative_factors,'注意要因','negative')+criteria(evidence?.official_criteria_status);
  return '<header class="detail-head"><h2>'+esc(s.origin)+' → '+esc(s.destination)+'</h2><p class="meta">'+esc(jpDate(s.service_date))+' · '+time(s.scheduled_departure)+'発 → '+time(s.scheduled_arrival)+'着 · '+ship(s.ship_type)+' · '+esc(s.service_number)+'便</p><button class="notification-btn watch-service-button" data-watch-service="'+esc(s.service_id)+'" aria-label="この便の通知設定" aria-pressed="false" title="この便の通知を設定">${BELL_MARKUP}</button></header>'+officialDetail(s)+(published&&Number.isFinite(Date.parse(published))?'<div class="detail-forecast-meta">更新 '+esc(updateTimeLabel(new Date(published)))+'</div>':'')+'<div class="ordinal-grid detail-overview">'+assessmentComment(view,group?group.assessment?.assessment:s.summary||s.assessment,stale?'更新に失敗したため、前回の予測を表示しています':null)+'</div><div data-history-chart></div>'+changedDetail(s)+'<div data-weather-primary></div>'+foldDetail('さらに詳しい気象予報','<div data-weather-secondary></div>','detail-weather-more')+foldDetail('予測の根拠',reason,'detail-reasons')+((latest?.ml_predictions||[]).length?foldDetail('モデル比較',modelDetail(latest.ml_predictions),'detail-models'):'');
}
`;
