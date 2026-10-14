import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {DETAIL_LAYOUT_JS} from '../src/ui/detail-layout.js';

const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const service={service_id:'id',service_date:'2026-10-10',origin:'大島',destination:'東京',ship_type:'jet',scheduled_departure:'2026-10-10T14:55:00+09:00',scheduled_arrival:'2026-10-10T16:40:00+09:00',official_status:'就航',official_port:'岡田港',official_note:'満席です',port_prediction:'元町',prediction_created_at:'current',summary:'コメント'};
// Keep the fixture's "today" stable as the actual calendar advances.
class FixtureDate extends Date {
 constructor(value?: string | number) { super(value ?? '2026-10-10T00:00:00+09:00'); }
}
function evaluate(expr:string,extra:Record<string,unknown>={}){
 return runInNewContext(DETAIL_LAYOUT_JS+'\n'+expr,{Date:FixtureDate,esc,service,history:[],time:(v:string)=>v.slice(11,16),jpDate:(v:string)=>v,ship:()=> '高速ジェット船',updateTimeLabel:(v:Date)=>v.toISOString(),assessmentComment:()=>'<section class="assessment-overview">コメント</section>',confidencePanel:()=>'',factors:()=>'',criteria:()=>'',portReason:()=>'',...extra});
}
test('detail puts one official status before forecast and preserves port and note',()=>{
 const html=evaluate('detailLayout(service,history,null)');
 assert.equal((html.match(/data-official-service=/g)||[]).length,1);
 assert.ok(html.indexOf('公式運航情報')<html.indexOf('assessment-overview'));
 assert.match(html,/岡田港/);assert.match(html,/満席です/);
 assert.doesNotMatch(html,/SERVICE DETAIL|港の予測：元町/);
 assert.match(html,/14:55発 → 16:40着/);
 assert.doesNotMatch(html,/<details[^>]* open/);
});
test('missing official information is explicit without a per-service port prediction',()=>{
 const html=evaluate('detailLayout(service,history,null)',{service:{...service,official_status:null,official_port:null,official_note:null}});
 assert.match(html,/未発表・未取得/);assert.doesNotMatch(html,/港の予測|出帆港予測/);
});
test('unchanged or unavailable comparison is omitted while real changes remain',()=>{
 assert.equal(evaluate('changedDetail({change:{evaluation_changed:false,port_changed:false,confidence_level_change:0}})'), '');
 assert.equal(evaluate('changedDetail({change:null})'), '');
 assert.match(evaluate('changedDetail({change:{evaluation_changed:true,port_changed:false,confidence_level_change:null}})'),/AI評価が変わりました/);
 assert.doesNotMatch(evaluate('changedDetail({change:{evaluation_changed:true,port_changed:false,confidence_level_change:null}})'),/確信度/);
});
test('model evidence comes only from the displayed prediction, never an unrelated history row',()=>{
 const model={weatherModel:'old weather',marineModel:'old marine',cancellationProbability:.5};
 assert.doesNotMatch(evaluate('detailLayout(service,history,null)',{history:[{created_at:'other',ml_predictions:[model]}]}),/old weather/);
 assert.match(evaluate('detailLayout(service,history,null)',{history:[{created_at:'current',ml_predictions:[model]}]}),/old weather/);
});
test('official information is shown today, or for an announced future sailing, using JST',()=>{
 const now=new Date('2026-10-09T15:10:00Z');
 assert.equal(evaluate('showOfficialForService(service,now)',{service:{service_date:'2026-10-10'},now}),true);
 assert.equal(evaluate('showOfficialForService(service,now)',{service:{service_date:'2026-10-11',official_status:null},now}),false);
 assert.equal(evaluate('showOfficialForService(service,now)',{service:{service_date:'2026-10-11',official_status:'欠航'},now}),true);
 assert.equal(evaluate('showOfficialForService(service,now)',{service:{service_date:'2026-10-09',official_status:'就航'},now}),false);
});
test('history is directly below the comment and model comparison remains folded',()=>{
 const html=evaluate('detailLayout(service,history,null)',{history:[{created_at:'current',ml_predictions:[{weatherModel:'weather',marineModel:'marine',cancellationProbability:.1}]}]});
 assert.match(html, /assessment-overview[^]*<\/div><div data-history-chart><\/div>/);
 assert.doesNotMatch(html,/対象便をまとめたAI予測|>AI予測</);
 assert.match(html, /<details class="detail-fold detail-models">/);
});
