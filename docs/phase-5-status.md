# Phase 5 status

The Worker now serves an installable PWA shell with a versioned service worker. The shell and static assets are cached, successful stored-prediction reads are retained, and an offline request returns the last cached result with an explicit stale marker. The UI also displays an offline banner and never presents cached data as current.

Login-free Web Push subscriptions are stored in D1 with route and trigger preferences. The initial UI preset enables notifications for operation likelihood below 50%, changes of at least 20 points, transitions into the under-50% risk state, and predicted-port changes. The storage model supports the 30% threshold and other route groups through the API even though a full settings sheet is not yet exposed.

Cron evaluates notification conditions only after a new prediction is saved. Active event keys are persisted per subscription and service, preventing the same unchanged condition from being sent every two hours. A cleared condition removes its active state so a later recurrence can notify again. Push delivery failures are isolated from prediction persistence; expired endpoints are removed after HTTP 404 or 410.

Push messages contain no prediction payload or personal data. They are contentless VAPID-authenticated Web Push requests; the service worker shows a generic change notification and opens the application, which then reads the latest stored result. `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` must be configured before notification enrollment becomes available.
