export async function runLatestAiBackfill(env: { DB: D1Database; GROQ_API_KEY?: string; GEMINI_API_KEY?: string }, fetchFn: typeof fetch = fetch, retryRunId?: string) {
  void env; void fetchFn; void retryRunId;
  return { status: "requires_full_forecast_rerun", reason: "AI評価には同じ実行回の気象・海象コンテキストが必要です。" };
}
