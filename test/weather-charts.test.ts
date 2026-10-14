import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { WEATHER_CHARTS_JS } from '../src/ui/weather-charts.js';

function evaluate(expression: string, values: Record<string, unknown> = {}) {
  return runInNewContext(`${WEATHER_CHARTS_JS}\n${expression}`, {
    document: { addEventListener() {} }, ...values
  });
}
const wind = [{ variable: 'wind_speed_10m', aggregation: 'route_max', unit: 'm/s', model: 'test', values: [
  { time: '2026-10-10T21:00:00Z', value: 10 }, { time: '2026-10-11T03:00:00Z', value: 12 }
] }];

test('chart uses ship-specific route limits only for matching variables and aggregation', () => {
  assert.equal(evaluate("weatherThresholds(series,{ship_type:'jet'}).stop", { series: wind }), 18);
  assert.equal(evaluate("weatherThresholds(series,{ship_type:'large'}).change", { series: wind }), 20);
  assert.equal(evaluate("weatherThresholds(series,{ship_type:'large'}).stop", { series: wind }), 23);
  assert.equal(evaluate("weatherThresholds(series,{ship_type:'jet'})", { series: [{ ...wind[0], variable: 'wind_gusts_10m' }] }), null);
  assert.equal(evaluate("weatherThresholds(series,{ship_type:'jet'})", { series: [{ ...wind[0], variable: 'swell_wave_height' }] }), null);
  assert.equal(evaluate("weatherThresholds(series,{ship_type:'jet'})", { series: [{ ...wind[0], aggregation: 'route_mean' }] }), null);
  assert.equal(evaluate('weatherThresholds(series,{})', { series: wind }), null);
});

test('axis includes both ends, hourly minor ticks, and readable labels at narrow widths', () => {
  const result = evaluate('weatherTimeTicks(0,9*wcHour,180)');
  assert.equal(result.labels[0], 0);
  assert.equal(result.labels.at(-1), 9 * 3_600_000);
  assert.equal(result.minor.length, 10);
  for (let i = 1; i < result.labels.length; i++) assert.ok((result.labels[i] - result.labels[i - 1]) / (9 * 3_600_000) * 180 >= 40);
});

test('chart retains baselines above low forecasts and uses actual elapsed time for gaps', () => {
  const series = [{ ...wind[0], values: [
    { time: '2026-10-10T21:00:00Z', value: 1 },
    { time: '2026-10-10T22:00:00Z', value: 2 },
    { time: '2026-10-11T03:00:00Z', value: 3 }
  ] }];
  const html = evaluate("weatherChart(series,{ship_type:'jet'},320)", { series });
  assert.match(html, /data-threshold="18"/);
  assert.match(html, /変更基準 15/);
  assert.match(html, /中止基準 18/);
  assert.doesNotMatch(html, /<text class="weather-limit-label"/);
  assert.match(html, /06:00/);
  const points = html.match(/points="([^"]+)"/)![1].split(' ').map((point: string) => Number(point.split(',')[0]));
  assert.ok(Math.abs((points[1] - points[0]) / (points[2] - points[0]) - 1 / 6) < .001);
});

test('voyage band and centered ship use exact schedule timestamps across midnight', () => {
  const service = {ship_type:'jet',scheduled_departure:'2026-10-10T23:30:00+09:00',scheduled_arrival:'2026-10-11T01:15:00+09:00'};
  const series = [{ ...wind[0], values: [{time:'2026-10-10T13:00:00Z',value:8},{time:'2026-10-10T17:00:00Z',value:9}] }];
  const html = evaluate('weatherChart(series,service,320)', {series,service});
  const band = html.match(/class="weather-voyage-band"[^>]+x="([^"]+)"[^>]+width="([^"]+)"/)!
  assert.ok(Math.abs(Number(band[2]) - (320-42)*1.75/4) < .001);
  const center = Number(html.match(/weather-voyage-button" style="left:([^p]+)px/)![1]);
  assert.ok(Math.abs(center-Number(band[1])-Number(band[2])/2) < .001);
  assert.match(html,/出航 10\/10 23:30 → 着港 10\/11 01:15/);
  assert.doesNotMatch(evaluate('weatherChart(series,{scheduled_departure:"bad"},320)',{series}),/weather-voyage-band|weather-voyage-button/);
});

test('JST midnight receives its new date without duplicate labels for a single sample', () => {
  const html = evaluate("weatherChart(series,{ship_type:'jet'},375)", { series: [{ ...wind[0], values: [
    { time: '2026-10-10T13:00:00Z', value: 10 }, { time: '2026-10-10T17:00:00Z', value: 12 }
  ] }] });
  assert.match(html, /10\/10/); assert.match(html, /10\/11/);
  assert.equal(evaluate('weatherTimeTicks(0,0,180).labels.length'), 1);
});
