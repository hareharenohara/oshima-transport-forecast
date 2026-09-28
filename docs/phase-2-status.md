# Phase 2 status

Weather models are requested from JMA MSM, ECMWF IFS, and GFS. Marine models are requested from ECMWF WAM and GFS Wave. Each request batches all 11 audited points.

Live validation on 2026-09-28 found that JMA MSM returned missing `wind_gusts_10m` values at required points and ECMWF WAM returned missing wind-wave components. They cannot reproduce all 127 audited features and are excluded from ML inference with explicit failure records. ECMWF/GFS weather combined with GFS Wave produced complete features and model probabilities. No missing value was filled or approximated.

The comparison output includes mean, min, max, range, population standard deviation, configurable agreement class, per-model values, and source failures.

`POST /api/assess` exposes the Phase 2 pipeline. Gemini 3.5 Flash-Lite first converts the comparison and explicit failures into a validated numerical summary. Gemini 3.8 Flash then produces the validated final assessment. Both stages use structured JSON schemas and prompt version `assessment-v2`. A retry is limited to one extra request for HTTP 429 or 5xx. Any authentication, availability, parsing, or range failure returns the complete ML result with `aiStatus: "unavailable"`; a successfully validated intermediate summary is preserved when only the final stage fails.
