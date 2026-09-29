# Phase 3 status

The local D1 and Cron foundation is implemented. Migration `0001_phase3.sql` creates services, forecast runs, append-only ML and AI prediction history, actual results, and structured run logs.

The scheduled handler runs every two hours. A unique UTC two-hour `run_slot` prevents duplicate execution. It selects only future services without confirmed actual results, runs the Phase 2 pipeline, stores every valid per-model ML value, preserves Gemini fallback status, and records service-level failures without stopping the remaining services.

ML runs for every target on every two-hour invocation. Gemini also remains on the two-hour cadence, but all services are combined into one summary-model request and one final-model request. Each run records the batch size and attempted call count in `run_logs` as `gemini_batch`, so quota behavior is auditable without logging credentials.

Each run also reads the official Tokai Kisen same-day Oshima operation page and stores matched service statuses separately from predictions and confirmed actual results. Failure of the official page or parser is logged as a warning and does not stop weather prediction. Official wording and source update time are preserved; elapsed schedule time is never used to invent a departure result.

Read APIs expose day summaries, latest service state with changes from the prior prediction, and complete prediction history. Local integration on 2026-09-28 verified one service, two ML model combinations, a generated Gemini assessment, and duplicate-run suppression.

The preview D1 database is provisioned in Cloudflare APAC, migration `0001_phase3.sql` is applied remotely, and `GEMINI_API_KEY` is registered as a preview secret. Preview Worker version `a6c4d3fa-2057-426e-b233-bc146c66f72f` is deployed at `https://tokai-kisen-forecast-preview.hareharenohara.workers.dev`; remote health and empty-D1 reads were verified on 2026-09-28.

The production UUID remains a placeholder. Create and migrate the production D1 database before production deployment. The preview database is populated by the scheduled handler rather than by manual seed data.

Schedule ingestion is now implemented through a replaceable `ScheduleProvider`. Bundled rules are based on the official Tokai Kisen timetables checked on 2026-09-28. They cover verified core Oshima services from 2026-09-28 through 2027-01-31, including published large-ship exclusion dates. Calendar-dependent A/B/C jet services are deliberately excluded until their calendar can be represented and tested without guessing.

Each Cron upserts the next four days before selecting prediction targets. Open-Meteo model responses are fetched once per run and reused across services. A local live run synced 23 services and completed 20 eligible service predictions in about five seconds with no service errors; every saved service contained two valid ML model combinations.
