import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { UPDATE_TIMES_JS } from '../src/ui/update-times.js';

const now=Date.parse('2026-10-14T09:46:00+09:00');
function evaluate(expression:string){
  return runInNewContext(UPDATE_TIMES_JS+'\n'+expression,{now,setInterval:()=>0,document:{addEventListener:()=>{}},Date,Intl});
}
test('relative timestamps match the requested current and next update example',()=>{
  assert.equal(evaluate("relativeUpdateText('2026-10-14T09:46:00+09:00','last',now)"),'たった今');
  assert.equal(evaluate("relativeUpdateText('2026-10-14T10:00:00+09:00','next',now)"),'あと14分');
  assert.equal(evaluate("updateClockText('2026-10-14T09:46:00+09:00','last',now)"),'(09:46)');
  assert.equal(evaluate("updateClockText('2026-10-14T10:00:00+09:00','next',now)"),'(10:00予定)');
});
test('last update uses elapsed whole minutes while the next update rounds up',()=>{
  assert.equal(evaluate("relativeUpdateText('2026-10-14T09:45:01+09:00','last',now)"),'たった今');
  assert.equal(evaluate("relativeUpdateText('2026-10-14T09:44:01+09:00','last',now)"),'1分前');
  assert.equal(evaluate("relativeUpdateText('2026-10-14T09:46:01+09:00','next',now)"),'あと1分');
  assert.equal(evaluate("relativeUpdateText('2026-10-14T11:00:00+09:00','next',now)"),'あと1時間14分');
});
test('missing, expired and future timestamps do not invent an update',()=>{
  assert.equal(evaluate("relativeUpdateText(null,'last',now)"),'未取得');
  assert.equal(evaluate("relativeUpdateText(null,'next',now)"),'予定なし');
  assert.equal(evaluate("updateClockText('invalid','next',now)"),'');
  assert.equal(evaluate("relativeUpdateText('2026-10-14T09:45:00+09:00','next',now)"),'予定なし');
  assert.equal(evaluate("relativeUpdateText('2026-10-14T10:00:00+09:00','last',now)"),'時刻を確認');
});
test('absolute times retain the date across JST midnight',()=>{
  assert.equal(evaluate("updateClockText('2026-10-13T23:59:00+09:00','last',now)"),'(10/13 23:59)');
  assert.equal(evaluate("updateClockText('2026-10-15T10:00:00+09:00','next',now)"),'(10/15 10:00予定)');
});
