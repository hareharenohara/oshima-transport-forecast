/** Shared entry point for notification controls; browser visits promote installation. */
export const NOTIFICATION_INSTALL_HTML = `<dialog id="notification-install-dialog" aria-labelledby="notification-install-title">
<h2 id="notification-install-title">アプリで便の通知を受け取る</h2>
<p class="notification-help">大島航路予報をホーム画面に追加すると、対象便の評価や運航状況の変化を通知で受け取れます。</p>
<ol id="notification-install-steps"></ol>
<p class="notification-help">追加済みの方は、ホーム画面やアプリ一覧の「大島航路予報」アイコンから開いてください。</p>
<div class="dialog-actions"><button type="button" data-install-close>閉じる</button><button type="button" id="notification-install-button" hidden>インストール</button></div>
<p id="notification-install-status" role="status" aria-live="polite"></p></dialog>`;

export const NOTIFICATION_INSTALL_CSS = `#notification-install-dialog{max-height:88vh;overflow:auto}#notification-install-dialog .notification-help{font-size:13px;line-height:1.8;color:var(--muted)}#notification-install-steps{padding-left:24px;font-size:14px;line-height:1.9}#notification-install-steps li{margin:10px 0}#notification-install-button{background:var(--sea);color:#fff}`;

export const NOTIFICATION_INSTALL_JS = `const installDialog=document.querySelector('#notification-install-dialog'),installButton=document.querySelector('#notification-install-button'),installStatus=document.querySelector('#notification-install-status');
const appDisplay=window.matchMedia('(display-mode: standalone)');
const isAppWindow=()=>navigator.standalone===true||appDisplay.matches;
const isAppleMobile=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let installPrompt=null,installBusy=false,pendingNotification=null;
function renderInstallGuide(){const steps=isAppleMobile()?['ブラウザの共有メニューを開きます。項目が見つからない場合はSafariでこのページを開いてください。','「ホーム画面に追加」を選び、「追加」を押します。「Webアプリとして開く」が表示されたらオンにします。','ホーム画面の「大島航路予報」を開き、ベルから通知を設定します。']:['ブラウザのメニューやアドレスバーから「アプリをインストール」または「ホーム画面に追加」を選びます。','追加した「大島航路予報」のアイコンから開き、ベルから通知を設定します。'];document.querySelector('#notification-install-steps').innerHTML=steps.map(s=>'<li>'+s+'</li>').join('');installButton.hidden=!installPrompt;installButton.disabled=installBusy;}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;renderInstallGuide()});
window.addEventListener('appinstalled',()=>{installPrompt=null;renderInstallGuide();installStatus.textContent='インストールされました。追加したアイコンから開いて通知を設定してください。'});
document.querySelector('[data-install-close]').onclick=()=>installDialog.close();installDialog.addEventListener('close',()=>{pendingNotification=null});
function requireNotificationApp(serviceId){if(isAppWindow())return true;pendingNotification={serviceId:serviceId||null};installStatus.textContent='';renderInstallGuide();if(!installDialog.open)installDialog.showModal();return false;}
appDisplay.addEventListener('change',()=>{if(!isAppWindow()||!installDialog.open||!pendingNotification)return;const next=pendingNotification;installDialog.close();openNotifications(next.serviceId)});
installButton.onclick=async()=>{if(!installPrompt||installBusy)return;const prompt=installPrompt;installPrompt=null;installBusy=true;installButton.disabled=true;try{await prompt.prompt();const choice=await prompt.userChoice;installStatus.textContent=choice.outcome==='accepted'?'インストール後、追加したアイコンから開いて通知を設定してください。':'インストールをキャンセルしました。あとからブラウザのメニューから追加できます。';}catch{installStatus.textContent='ブラウザのメニューからホーム画面への追加をお試しください。';}finally{installBusy=false;renderInstallGuide()}};`;
