# Phase 6 status

## Verified on 2026-09-29

- The full test suite passes with explicit 0% and 100% assessment boundaries and rejection above 100%.
- Open-Meteo/feature failures remain `PREDICTION_UNAVAILABLE`; no fallback probability is invented.
- Gemini HTTP and schema failures preserve ML output and mark the AI assessment unavailable.
- D1 read failures now return a structured HTTP 503 `STORAGE_UNAVAILABLE` response instead of an unhandled exception.
- Missing previous AI probabilities no longer render as `nullポイント`.
- Six stored history points from the preview D1 can be rendered as a prediction trend chart using the documented ML fallback when AI values are absent.
- Long summaries and factor strings wrap within the mobile detail sheet.
- The deployed Preview was visually checked at the narrow in-app mobile viewport in light and dark themes. Day cards, service expansion, 100% display, and the service detail sheet remain readable.
- PWA assets, manifest, service worker, VAPID public configuration, and notification settings are served from Preview.

## Remaining device verification

The following checks require physical devices and cannot be completed by desktop emulation alone:

- Android installation, background Push receipt, notification tap, and offline relaunch.
- iPhone Add to Home Screen behavior, standalone relaunch, Push permission, background receipt, and notification tap.

Push delivery also requires at least one real browser subscription and a later Cron result that crosses its selected notification condition. No test subscription was created on behalf of the user during automated verification.
