# Phase 2 status

Groq is the primary AI provider. It uses `openai/gpt-oss-20b` for the batched forecast summary and `openai/gpt-oss-120b` for the final grounded assessment with strict JSON Schema output. Gemini remains as the provider fallback. Every outbound AI response is audited with provider, model, HTTP status, and reported token usage; ML remains the final availability fallback.

Weather models are requested from JMA MSM, ECMWF IFS, and GFS. Marine models are requested from ECMWF WAM and GFS Wave. Each request batches all 11 audited points.

Live validation on 2026-09-28 found that JMA MSM returned missing `wind_gusts_10m` values at required points and ECMWF WAM returned missing wind-wave components. They cannot reproduce all 127 audited features and are excluded from ML inference with explicit failure records. ECMWF/GFS weather combined with GFS Wave produced complete features and model probabilities. No missing value was filled or approximated.

The comparison output includes mean, min, max, range, population standard deviation, configurable agreement class, per-model values, and source failures.

`POST /api/assess` exposes the Phase 2 pipeline. The primary Groq path receives a compact, unit-preserving, model-separated context for departure, route, and arrival conditions. The 20B model organizes those facts without deciding operation probability; the 120B model produces the final assessment. Official near/reached comparisons are copied deterministically from the input before grounding validation, so the language model cannot alter their value, unit, threshold, or status. The Groq prompt version is `assessment-v6-groq-primary`.

Cron keeps the two-stage design while batching all target services. Every two-hour run first requests a Groq 20B summary, then a Groq 120B final assessment. If either primary stage fails or omits a service, the entire batch moves to the existing Gemini model chains. HTTP attempts record provider, model, status, and provider-reported token counts in `run_logs`; the selected provider and models are also stored with each AI prediction. An omitted, duplicate, malformed, ungrounded, or fully failed batch never reuses an older result; the affected run remains explicitly ML provisional.
