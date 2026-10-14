import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedForecastDays } from '../src/worker/forecast-cache.js';

test('forecast cache shares public data within a bucket and expires at publication boundaries', async () => {
  const entries = new Map<string, Response>();
  const cache = {
    async match(key: Request) { return entries.get(key.url)?.clone(); },
    async put(key: Request, response: Response) { entries.set(key.url, response.clone()); }
  } as unknown as Cache;
  let reads = 0;
  const build = async () => Response.json({ days: [++reads], requestId: 'original' }, { headers: { 'Cache-Control': 'no-store' } });
  const request = new Request('https://example.test/api/days?from=2026-10-10&unused=a');
  await cachedForecastDays(request, '2026-10-10', 'a', build, cache, 29_900);
  const hit = await cachedForecastDays(new Request('https://example.test/api/days?unused=b'), '2026-10-10', 'b', build, cache, 29_999);
  assert.equal(reads, 1);
  assert.deepEqual(await hit.json(), { days: [1], requestId: 'b' });
  assert.equal(hit.headers.get('Cache-Control'), 'no-store');
  await cachedForecastDays(request, '2026-10-10', 'c', build, cache, 30_000);
  assert.equal(reads, 2);
  await cachedForecastDays(request, '2026-10-11', 'd', build, cache, 30_001);
  assert.equal(reads, 3);
  await cachedForecastDays(new Request('https://other.test/api/days'), '2026-10-11', 'e', build, cache, 30_001);
  assert.equal(reads, 4);
});

test('forecast cache never saves failures and works when edge caching is unavailable', async () => {
  let writes = 0;
  const cache = { async match() { throw Error('cache unavailable'); }, async put() { writes++; } } as unknown as Cache;
  const request = new Request('https://example.test/api/days');
  const failed = await cachedForecastDays(request, '2026-10-10', 'a', async () => new Response('failed', { status: 503 }), cache);
  assert.equal(failed.status, 503);
  assert.equal(writes, 0);
  assert.equal((await cachedForecastDays(request, '2026-10-10', 'b', async () => new Response('ok'), undefined)).status, 200);
  const brokenPut = { async match() { return undefined; }, async put() { throw Error('cache unavailable'); } } as unknown as Cache;
  assert.equal((await cachedForecastDays(request, '2026-10-10', 'c', async () => new Response('ok'), brokenPut)).status, 200);
});
