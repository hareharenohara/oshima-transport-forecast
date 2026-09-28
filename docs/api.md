# Phase 1 prediction API

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
