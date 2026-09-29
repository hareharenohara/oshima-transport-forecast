# Phase 2 status

Weather models are requested from JMA MSM, ECMWF IFS, and GFS. Marine models are requested from ECMWF WAM and GFS Wave. Each request batches all 11 audited points.

Live validation on 2026-09-28 found that JMA MSM returned missing `wind_gusts_10m` values at required points and ECMWF WAM returned missing wind-wave components. They cannot reproduce all 127 audited features and are excluded from ML inference with explicit failure records. ECMWF/GFS weather combined with GFS Wave produced complete features and model probabilities. No missing value was filled or approximated.

The comparison output includes mean, min, max, range, population standard deviation, configurable agreement class, per-model values, and source failures.

`POST /api/assess` exposes the Phase 2 pipeline. Gemini 3.5 Flash-Lite first converts the comparison and explicit failures into a validated numerical summary. Gemini 3.8 Flash then produces the validated final assessment. Both stages use structured JSON schemas. Single-service requests retain prompt version `assessment-v3-batch`; Cron uses the same version with a service-ID-keyed batch schema. A retry is limited to one extra request for HTTP 429 or 5xx and respects `Retry-After`; it no longer retries immediately. Any authentication, availability, parsing, or range failure returns the complete ML result with `aiStatus: "unavailable"`; a successfully validated intermediate summary is preserved when only the final stage fails.

Cron preserves the two-stage Gemini design while batching all target services. Every two-hour run makes one Gemini 3.5 Flash-Lite request for per-service summaries, followed by one Gemini 3.8 Flash request for per-service final assessments. The structured response retains each `service_id` and is split back into service-level D1 rows only after validation. Normal use is therefore 2 Gemini requests per Cron: 12 final-model calls and 12 summary-model calls per day. An omitted, duplicate, malformed, or failed batch never reuses an older Gemini result; the affected run remains explicitly ML provisional.
