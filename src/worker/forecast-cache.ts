// Public forecast data only. Fixed buckets avoid carrying a response across a
// publication boundary (all scheduled publications fall on whole minutes).
export async function cachedForecastDays(
  request: Request, from: string, requestId: string, build: () => Promise<Response>,
  cache: Cache | undefined, now = Date.now()
): Promise<Response> {
  const bucketMs = 30_000;
  const keyUrl = new URL(request.url);
  keyUrl.pathname = `/__forecast-days-cache/v1/${from}/${Math.floor(now / bucketMs)}`;
  keyUrl.search = '';
  const key = new Request(keyUrl, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const data = await hit.json() as Record<string, unknown>;
        return Response.json({ ...data, requestId }, { headers: {
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
        } });
      }
    } catch { /* Cache failures must not prevent reading current forecasts. */ }
  }
  const response = await build();
  if (cache && response.ok) {
    try {
      const copy = response.clone();
      const headers = new Headers(copy.headers);
      headers.set('Cache-Control', `public, max-age=${Math.max(1, Math.ceil((bucketMs - now % bucketMs) / 1000))}`);
      await cache.put(key, new Response(copy.body, { status: copy.status, headers }));
    } catch { /* Best effort: D1 response remains usable. */ }
  }
  return response;
}
