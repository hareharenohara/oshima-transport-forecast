/** Relative text describes the timestamps, not whether an update is running. */
export const UPDATE_TIMES_JS = `
function relativeUpdateText(at,kind,now=Date.now()){
  const time=Date.parse(at);
  if(!Number.isFinite(time))return kind==='next'?'予定なし':'未取得';
  const delta=kind==='next'?time-now:now-time;
  if(kind==='next'&&delta<=0)return '予定なし';
  if(kind==='last'&&delta<0)return '時刻を確認';
  if(kind==='last'&&delta<60000)return 'たった今';
  const minutes=kind==='next'?Math.ceil(delta/60000):Math.floor(delta/60000);
  const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;
  const duration=days?days+'日'+(hours?hours+'時間':''):hours?hours+'時間'+(rest?rest+'分':''):minutes+'分';
  return kind==='next'?'あと'+duration:duration+'前';
}
function updateClockText(at,kind,now=Date.now()){
  const time=Date.parse(at);if(!Number.isFinite(time))return '';
  const day=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(value));
  const options={timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',...(day(time)!==day(now)?{month:'numeric',day:'numeric'}:{})};
  return '('+new Intl.DateTimeFormat('ja-JP',options).format(new Date(time))+(kind==='next'?'予定':'')+')';
}
function refreshRelativeUpdates(){
  let expired=false;
  document.querySelectorAll('[data-update-relative]').forEach(el=>{
    const at=el.dataset.at,kind=el.dataset.updateRelative;
    el.textContent=relativeUpdateText(at,kind);
    if(kind==='next'&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.now())expired=true;
    const clock=el.parentElement.querySelector('.update-clock');
    if(clock)clock.textContent=updateClockText(at,kind);
  });
  if(expired&&!document.hidden&&typeof load==='function')load();
}
setInterval(refreshRelativeUpdates,30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshRelativeUpdates()});
`;
