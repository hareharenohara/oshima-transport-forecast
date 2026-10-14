import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { NOTIFICATION_INSTALL_JS } from '../src/ui/notification-install.js';

function harness(standalone=false, apple=false) {
  const listeners=new Map<string, (event?: unknown)=>void>();
  const elements=new Map<string, any>();
  for(const id of ['#notification-install-dialog','#notification-install-button','#notification-install-status','#notification-install-steps','[data-install-close]']) {
    elements.set(id,{open:false,hidden:true,textContent:'',innerHTML:'',disabled:false,showModal(){this.open=true},close(){this.open=false;listeners.get('close')?.()},addEventListener(type:string,callback:()=>void){listeners.set(type,callback)}});
  }
  const display={matches:standalone,addEventListener(type:string,callback:()=>void){listeners.set('display-'+type,callback)}};
  const opened:unknown[]=[];
  const context=vm.createContext({document:{querySelector:(id:string)=>elements.get(id)},window:{matchMedia:()=>display,addEventListener:(type:string,callback:()=>void)=>listeners.set(type,callback)},navigator:{standalone:false,userAgent:apple?'iPhone':'Chrome',platform:'',maxTouchPoints:0},openNotifications:(id:unknown)=>opened.push(id)});
  vm.runInContext(NOTIFICATION_INSTALL_JS,context);
  return {elements,listeners,display,opened,context,require:(id:unknown)=>vm.runInContext('requireNotificationApp('+JSON.stringify(id)+')',context)};
}

test('browser notification entry requires installation; standalone and iOS app launches bypass guide',()=>{
  const h=harness(false,true);
  assert.equal(h.require('future'),false);
  assert.equal(h.elements.get('#notification-install-dialog').open,true);
  assert.match(h.elements.get('#notification-install-steps').innerHTML,/共有メニュー/);
  assert.equal(h.elements.get('#notification-install-button').hidden,true);
  h.display.matches=true;
  h.listeners.get('display-change')?.();
  assert.deepEqual(h.opened,['future']);
  assert.equal(h.require(null),true);
  const ios=harness();
  vm.runInContext('navigator.standalone=true',ios.context);
  assert.equal(ios.require(null),true);
  assert.equal(ios.elements.get('#notification-install-dialog').open,false);
});

test('install prompt is consumed once and dismissed installation leaves manual guidance',async()=>{
  const h=harness();
  let prompted=0,prevented=0;
  h.listeners.get('beforeinstallprompt')?.({preventDefault:()=>prevented++,prompt:async()=>{prompted++},userChoice:Promise.resolve({outcome:'dismissed'})});
  assert.equal(prevented,1);
  assert.equal(h.elements.get('#notification-install-button').hidden,false);
  h.require('future');
  await h.elements.get('#notification-install-button').onclick();
  await h.elements.get('#notification-install-button').onclick();
  assert.equal(prompted,1);
  assert.match(h.elements.get('#notification-install-status').textContent,/キャンセル/);
  assert.equal(h.elements.get('#notification-install-button').hidden,true);
  assert.deepEqual(h.opened,[]);
  h.listeners.get('appinstalled')?.();
  assert.match(h.elements.get('#notification-install-status').textContent,/追加したアイコン/);
  assert.deepEqual(h.opened,[]);
});
