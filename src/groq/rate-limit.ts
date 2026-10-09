export interface RateClock { now(): number; sleep(ms: number): Promise<void> }
// Mixed Japanese/ASCII JSON: byte/2 substantially overcounts numeric tables.
// Keep a conservative envelope; actual usage and server headers govern pacing.
export function estimateRequestTokens(body: {messages?:unknown;response_format?:unknown}): number {
  const text=JSON.stringify({messages:body.messages,schema:body.response_format});
  const nonAscii=Array.from(text).filter(char=>char.codePointAt(0)!>127).length;
  return Math.ceil((text.length-nonAscii)/2.6+nonAscii*1.3)+256;
}
const defaultClock: RateClock = { now: Date.now, sleep: async (ms) => { while (ms > 0) { const part = Math.min(ms, 30_000); await new Promise(resolve => setTimeout(resolve, part)); ms -= part; } } };

function duration(value: string | null): number {
  if (!value) return 60_000;
  let ms = 0;
  for (const match of value.matchAll(/([\d.]+)(ms|s|m|h)/g)) ms += Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!] ?? 0);
  return ms || 60_000;
}

// One assessment invocation shares this controller across all groups and both stages.
// Input is estimated, not tokenized; server headers and actual usage are authoritative.
export function pacedGroqFetch(fetchFn: typeof fetch, clock: RateClock = defaultClock): typeof fetch {
  const windows = new Map<string, { until: number; used: number; remaining?: number }>();
  const deadline = clock.now() + 12 * 60_000;
  const send: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const model = String(body.model);
    const inputEstimate = estimateRequestTokens(body);
    if (inputEstimate >= 7_488) throw new Error(`Groq request input estimate ${inputEstimate} exceeds single-request budget; waiting cannot reduce its size`);
    if (8_000-inputEstimate < Number(body.max_completion_tokens)) throw new Error(`Groq request input estimate ${inputEstimate} leaves insufficient completion budget; split targets without discarding judgment material`);
    // Reserve input + the full allowed completion so the next request does not race output usage.
    body.max_completion_tokens = Math.min(Number(body.max_completion_tokens), 8_000 - inputEstimate);
    const reserved = inputEstimate + body.max_completion_tokens;
    let window = windows.get(model);
    if (window && clock.now() < window.until && (window.used + reserved > 8_000 || (window.remaining !== undefined && window.remaining < reserved))) {
      if (window.until >= deadline) throw new Error("Groq rate-limit wait exceeds assessment deadline");
      await clock.sleep(window.until - clock.now() + 100);
    }
    if (!window || clock.now() >= window.until) {
      window = { until: clock.now() + 60_000, used: 0 };
      windows.set(model, window);
    }
    window.used += reserved;
    const response = await fetchFn(url, { ...init, body: JSON.stringify(body) });
    try {
      const payload = await response.clone().json() as { usage?: { total_tokens?: number } };
      const actual = payload.usage?.total_tokens;
      if (typeof actual === "number" && Number.isFinite(actual)) window.used += actual - reserved;
    } catch { /* Headers remain available for non-JSON failures. */ }
    const remaining = response.headers.get('x-ratelimit-remaining-tokens');
    if (remaining !== null && Number.isFinite(Number(remaining))) window.remaining = Number(remaining);
    window.until = Math.max(window.until, clock.now() + duration(response.headers.get('x-ratelimit-reset-tokens')));
    if (response.status === 429) {
      window.remaining = 0;
      const retry = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retry) && retry > 0) window.until = Math.max(window.until, clock.now() + retry * 1000);
    }
    return response;
  };
  return async (url, init) => {
    const response = await send(url, init);
    // A 429 can be caused by other organization traffic; wait, then retry once.
    if (response.status !== 429) return response;
    await response.body?.cancel();
    return send(url, init);
  };
}
