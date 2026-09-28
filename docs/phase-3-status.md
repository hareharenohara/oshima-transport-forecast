# Phase 3 status

The local D1 and Cron foundation is implemented. Migration `0001_phase3.sql` creates services, forecast runs, append-only ML and AI prediction history, actual results, and structured run logs.

The scheduled handler runs every two hours. A unique UTC two-hour `run_slot` prevents duplicate execution. It selects only future services without confirmed actual results, runs the Phase 2 pipeline, stores every valid per-model ML value, preserves Gemini fallback status, and records service-level failures without stopping the remaining services.

Read APIs expose day summaries, latest service state with changes from the prior prediction, and complete prediction history. Local integration on 2026-09-28 verified one service, two ML model combinations, a generated Gemini assessment, and duplicate-run suppression.

The preview D1 database is provisioned in Cloudflare APAC, migration `0001_phase3.sql` is applied remotely, and `GEMINI_API_KEY` is registered as a preview secret. Preview Worker version `a6c4d3fa-2057-426e-b233-bc146c66f72f` is deployed at `https://tokai-kisen-forecast-preview.hareharenohara.workers.dev`; remote health and empty-D1 reads were verified on 2026-09-28.

The production UUID remains a placeholder. Create and migrate the production D1 database before production deployment. The preview database currently has no service schedule rows, so scheduled runs have no prediction targets until schedule ingestion is implemented.
