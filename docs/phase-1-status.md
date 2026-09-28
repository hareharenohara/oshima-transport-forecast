# Phase 1 status

## Implemented

- Open-Meteo weather and marine forecast retrieval for all 11 audited points
- Asia/Tokyo normalization and strict rejection of missing hourly values
- Route-specific point selection and audited aggregation windows
- 77 numeric values plus 50 one-hot values, with strict 127-feature validation
- A model compatibility gate that rejects an artifact whose ordered input vector differs from the audited specification
- Debug JSON and tests for feature count, duration, circular components, missing data, and model compatibility

On 2026-09-28 JST, a live API run successfully retrieved all 11 locations, generated 127 finite features for a Tokyo–Oshima sample service, and reached the model compatibility gate. The forecast request is batched into one weather and one marine request, with one bounded retry for HTTP 429/5xx.

## Audited model reconstruction

The supplied model bundle contained only the older 131-input model. The audited 127-input model was reconstructed from the supplied hourly training sources by excluding forecast hours after departure/estimated arrival, removing the four audited `*_circular_mean_deg` values, and normalizing voyage numbers to integer strings.

The reconstructed final-test metrics match the audit report: threshold 0.03, recall 92.3%, precision 32.3%, false-positive rate 21.5%, PR-AUC 0.698, and ROC-AUC 0.929. The active model is `models/cloudflare_portable_model.json`; the supplied model remains at `models/cloudflare_portable_model.legacy-131.json`.

Python and TypeScript inference agree on a golden input within `1e-15`. No Gemini, D1, UI, PWA, or Push work has been started.
