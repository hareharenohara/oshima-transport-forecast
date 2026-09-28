# Phase 1 status

## Implemented

- Open-Meteo weather and marine forecast retrieval for all 11 audited points
- Asia/Tokyo normalization and strict rejection of missing hourly values
- Route-specific point selection and audited aggregation windows
- 77 numeric values plus 50 one-hot values, with strict 127-feature validation
- A model compatibility gate that rejects an artifact whose ordered input vector differs from the audited specification
- Debug JSON and tests for feature count, duration, circular components, missing data, and model compatibility

On 2026-09-28 JST, a live API run successfully retrieved all 11 locations, generated 127 finite features for a Tokyo–Oshima sample service, and reached the model compatibility gate. The forecast request is batched into one weather and one marine request, with one bounded retry for HTTP 429/5xx.

## Blocking artifact mismatch

The provided `cloudflare_portable_model.json` has 131 inputs. It contains the four removed `*_circular_mean_deg` features and voyage levels such as `1100.0`. The provided audited specification has 127 inputs and voyage levels such as `1100`.

The system therefore returns `prediction_unavailable` instead of adapting, dropping, filling, or renaming features. To complete Phase 1, replace the model JSON and inference helper with the audited, retrained 127-feature artifacts whose ordered `feature_names` exactly match `docs/model/model_input_specification_127.csv`.

No Gemini, D1, UI, PWA, or Push work has been started.
