# Prediction API

## Health

`GET /health` returns the active model and feature-contract versions.

## Single-service prediction

`POST /api/predict` accepts one scheduled service. Times must be ISO 8601 with the explicit JST offset `+09:00`.

```json
{
  "serviceId": "2026-09-30-1100",
  "voyageNumber": "1100",
  "shipType": "jet",
  "direction": "to_oshima",
  "counterpartTerminal": "東京",
  "scheduledDepartureJst": "2026-09-30T08:00:00+09:00",
  "scheduledArrivalJst": "2026-09-30T09:45:00+09:00"
}
```

Successful responses contain `cancellationProbability`, `operationProbability`, the risk threshold, model/feature versions, and data-quality counts. These values are the historical ML weather-cancellation risk sensor, not the final site operation probability.

Input failures return HTTP 400 or 413. Forecast, feature, or inference failures return HTTP 503 with `PREDICTION_UNAVAILABLE`; the API never substitutes a default probability.

The request body limit is 16 KiB. Responses use `Cache-Control: no-store` because this endpoint performs live Phase 1 validation. Phase 3 will move prediction generation to Cron and serve stored results.

## Multi-model assessment

`POST /api/assess` accepts the same service object. It returns all complete weather/marine ML combinations, their comparison statistics, explicit source failures, the intermediate Gemini summary, and the final assessment. `operation_probability` and `confidence` in the AI result are integer percentages from 0 through 100.

If `GEMINI_API_KEY` is missing or either Gemini stage fails, the request still succeeds with the multi-model result, `aiStatus: "unavailable"`, and `ai: null`. Forecast coverage too small to compare at least two valid combinations returns HTTP 503.

## Stored prediction reads

- `GET /api/days?from=YYYY-MM-DD` returns five days of services with their latest AI prediction and any matched official status.
- `GET /api/services/:id` returns one service, its latest AI prediction, changes from the previous prediction, and any matched official status.
- `GET /api/services/:id/history` returns append-only AI and per-model ML history, newest first.
- `GET /api/services/:id/series` returns the latest stored route-level wind, gust, wave, wave-period, and swell time series, separated by forecast model.

These endpoints only read D1. Prediction generation is performed by the internal two-hour Cron handler.
Series values preserve the source units (`m/s`, `m`, and `s`). Route values are maxima, except wave period, which is the route mean. Series rows are retained for 30 days.

Official status fields are sourced from the Tokai Kisen same-day operation page and remain separate from forecast probabilities and confirmed historical outcomes. The application preserves labels such as `就航`, `天候調査中`, `欠航`, and `運休日`; it does not infer that a vessel physically departed merely because its scheduled departure time passed.

## Push notifications

- `GET /api/push/config` returns only the public VAPID key, or `null` when Push is not configured.
- `POST /api/push/subscriptions` stores a browser Push subscription and its notification preferences.
- `DELETE /api/push/subscriptions?id=...` removes the caller's stored subscription identifier.

Push endpoints and encryption keys are never returned by stored prediction APIs. The subscription identifier returned at enrollment is retained by the browser for later removal.
